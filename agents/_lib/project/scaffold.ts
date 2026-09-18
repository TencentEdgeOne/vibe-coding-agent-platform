import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import type { BuildResult, BuildStatus, ProjectState } from '../types.ts';
import { detectFatalToolError } from '../utils/text.ts';
import { runCommandCapturingExit, runSandboxCommand } from './commands.ts';
import { runMakersCompatibilityCheck } from '../makers/compat/run.ts';

export { repairNestedAppDirLayout } from './layout.ts';

/**
 * What the production build is still for once a preview has come up.
 *
 * The dev server compiles the project and the smoke gates exercise its routes,
 * so a healthy preview already answers "does this code run". What it does not
 * answer is "does the production build succeed" — prerendering, static
 * generation and bundling only happen there. Paying up to ten minutes for that
 * answer on every turn is what made iteration slow, and it is not the last
 * chance to get it: `edgeone makers deploy` runs the real build, and a failure
 * there comes back as a failed deployment carrying the CLI's own log.
 *
 * So the build stays a gate and stops being a toll. It runs when the preview
 * did not run or did not come up, which is exactly when nothing else has shown
 * that the project assembles.
 */
export type VerificationOptions = {
  previewVerified?: boolean;
};

/**
 * The build command a project declares in `edgeone.json`, if any.
 *
 * Read rather than inferred: for a generator there is no manifest to infer it
 * from, and this is the same value the deployment will run. A command spanning
 * lines is refused instead of run — nothing legitimate needs one, and the value
 * reaches a shell.
 */
async function readDeclaredBuildCommand(context: AgentContext, state: ProjectState) {
  const probe = await runSandboxCommand(
    context,
    'node -e "try { const c=require(\'./edgeone.json\'); process.stdout.write(typeof c.buildCommand === \'string\' ? c.buildCommand : \'\'); } catch (e) { process.stdout.write(\'\'); }"',
    { cwd: state.appDir, timeout: 30 },
  );
  if (probe.exitCode !== 0) return '';
  const declared = (probe.stdout || '').trim();
  return declared.includes('\n') ? '' : declared;
}

export const PRODUCTION_BUILD_DEFERRED =
  'Skipped the production build: the preview server compiled this project and passed its smoke tests in this turn, which is the same evidence the build would produce for everything except bundling and prerendering. Publishing runs the real build and reports any production-only failure with its own log.';

export async function runVerification(
  context: AgentContext,
  state: ProjectState,
  options: VerificationOptions = {},
): Promise<BuildResult> {
  try {
    const compatibility = await runMakersCompatibilityCheck(context, state);
    if (compatibility.exitCode !== 0) {
      return {
        status: 'failed',
        stdout: compatibility.stdout,
        stderr: [
          'Makers compatibility check failed.',
          compatibility.stderr || compatibility.stdout,
        ].filter(Boolean).join('\n'),
      };
    }
    const withCompatibilityOutput = (stdout = '') => (
      [compatibility.stdout.trim(), stdout.trim()].filter(Boolean).join('\n')
    );

    const packageExists = await requireSandbox(context).files.exists(`${state.appDir}/package.json`);
    if (packageExists) {
      const hasBuildScript = await runSandboxCommand(
        context,
        'node -e "try { const p=require(\'./package.json\'); process.stdout.write((p.scripts && p.scripts.build) ? \'yes\' : \'no\'); } catch (e) { process.stdout.write(\'error\'); }"',
        {
          cwd: state.appDir,
          timeout: 30,
        },
      );

      if (hasBuildScript.exitCode !== 0) {
        return {
          status: 'failed',
          stdout: withCompatibilityOutput(hasBuildScript.stdout),
          stderr: hasBuildScript.stderr || 'Failed to read package.json; unable to determine whether a build script exists.',
        };
      }

      const buildFlag = hasBuildScript.stdout.trim();
      if (buildFlag === 'error') {
        return {
          status: 'failed',
          stdout: withCompatibilityOutput(hasBuildScript.stdout),
          stderr: 'Failed to parse package.json; unable to determine whether a build script exists.',
        };
      }

      if (buildFlag === 'yes') {
        if (options.previewVerified) {
          return {
            status: 'success',
            stdout: withCompatibilityOutput(PRODUCTION_BUILD_DEFERRED),
          };
        }
        const result = await runCommandCapturingExit(context, 'npm run build', {
          cwd: state.appDir,
          timeout: 600,
        });

        return {
          status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
          stdout: withCompatibilityOutput(result.stdout),
          stderr: result.stderr,
        };
      }

      if (buildFlag !== 'no') {
        return {
          status: 'failed',
          stdout: withCompatibilityOutput(hasBuildScript.stdout),
          stderr: hasBuildScript.stderr || 'Failed to parse package.json; unable to determine whether a build script exists.',
        };
      }
    }

    // A site generator has no npm build script and often no package.json at
    // all — Hugo is a Go binary, Jekyll a Ruby one — so it declares its build in
    // edgeone.json instead. Without this branch such a project reached the end
    // of verification with nothing checked and passed for having nothing to
    // check, which is the one shape where a green turn meant least.
    const declaredBuild = await readDeclaredBuildCommand(context, state);
    if (declaredBuild) {
      if (options.previewVerified) {
        return {
          status: 'success',
          stdout: withCompatibilityOutput(PRODUCTION_BUILD_DEFERRED),
        };
      }
      const result = await runCommandCapturingExit(context, declaredBuild, {
        cwd: state.appDir,
        timeout: 600,
      });

      return {
        status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
        stdout: withCompatibilityOutput(result.stdout),
        stderr: result.stderr,
      };
    }

    const pythonFiles = await runSandboxCommand(
      context,
      [
        'find .',
        "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' -o -path './.venv' -o -path './venv' \\) -prune",
        "-o -name '*.py' -print -quit",
      ].join(' '),
      {
        cwd: state.appDir,
        timeout: 30,
      },
    );

    if (pythonFiles.exitCode !== 0) {
      return {
        status: 'failed',
        stdout: withCompatibilityOutput(pythonFiles.stdout),
        stderr: pythonFiles.stderr || 'Python file inspection failed.',
      };
    }

    if (pythonFiles.stdout.trim()) {
      const result = await runCommandCapturingExit(context, 'python -m compileall .', {
        cwd: state.appDir,
        timeout: 300,
      });

      return {
        status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
        stdout: withCompatibilityOutput(result.stdout),
        stderr: result.stderr,
      };
    }

    return {
      status: 'success',
      stdout: withCompatibilityOutput(
        'Nothing declared a build: no package.json build script, no buildCommand in edgeone.json, and no Python sources. Makers compatibility lint passed. If this project needs a build step, declare buildCommand and outputDirectory in edgeone.json — publishing runs what is declared there and nothing else.',
      ),
    };
  } catch (error) {
    const commandError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof commandError.stdout === 'string' ? commandError.stdout : '';
    const stderr = typeof commandError.stderr === 'string' ? commandError.stderr : '';
    const message = error instanceof Error ? error.message : String(error);
    const fatal = detectFatalToolError([stdout, stderr, message].filter(Boolean).join('\n'));
    return {
      status: 'failed',
      stdout,
      stderr: fatal || stderr || message || 'Verification failed.',
      ...(fatal ? { fatal: true } : {}),
    };
  }
}
