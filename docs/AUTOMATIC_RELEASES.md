# Automatic releases

The GitHub Actions workflow in `.github/workflows/release.yml` builds and publishes a Windows x64 portable release when a plain semantic-version tag is pushed (for example, `1.3.5`). It runs typecheck, tests, builds the app and bundled updater, creates release notes from commits, and uploads `Orbit-Chat-<version>-win-x64.zip` to `redoszeryk0-sys/OrbitChat-releases`. It also refreshes `Orbit-Chat-Updater.exe` on the legacy `Online_installer` release for older installations.

## One-time GitHub setup

The source and release assets live in the same `OrbitChat-releases` repository, so no personal access token or paid release service is needed. The workflow uses GitHub's built-in `GITHUB_TOKEN` with repository contents write permission. Make sure GitHub Actions are enabled for the repository.

## Publishing a version

1. Update `version` in both `package.json` and the root entry in `package-lock.json` to the same version.
2. Commit and push the changes to the source repository.
3. Create and push the matching tag, for example:

   ```powershell
   git tag 1.3.5
   git push origin 1.3.5
   ```

The workflow verifies the tag matches `package.json` before building. A failed build or test prevents the release from being published. No third-party paid release service is used; GitHub Actions runs the workflow.
