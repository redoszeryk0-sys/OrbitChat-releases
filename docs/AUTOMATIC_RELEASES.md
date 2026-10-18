# Automatic releases

The GitHub Actions workflow in `.github/workflows/release.yml` builds and publishes a Windows x64 portable release when a plain semantic-version tag is pushed (for example, `1.3.5`). It runs typecheck and tests, builds the app and bundled updater, and uploads only `Orbit-Chat-<version>-win-x64.zip` to `redoszeryk0-sys/OrbitChat-releases`. The updater is built in a temporary directory and included inside the portable ZIP; it is not published as a separate release asset. If `docs/releases/<version>.md` exists, it is used for the release notes; otherwise, notes are generated from commit subjects. Versioned app releases are marked not latest, and the `Online_installer` release is kept as Latest.

Every versioned app release is marked **not latest**. The non-versioned `Online_installer` release is explicitly kept as GitHub's **Latest** release so the download page promotes the installer.

## One-time GitHub setup

The source and release assets live in the same `OrbitChat-releases` repository, so no personal access token or paid release service is needed. The workflows use GitHub's built-in `GITHUB_TOKEN` with repository contents write permission. Make sure GitHub Actions are enabled for the repository.

## Publishing a version

1. Update `version` in both `package.json` and the root entry in `package-lock.json` to the same version.
2. Commit and push the changes to the source repository.
3. Create and push the matching tag, for example:

   ```powershell
   git tag 1.3.5
   git push origin 1.3.5
   ```

The workflow verifies the tag matches `package.json` before building. A failed build or test prevents the release from being published. No third-party paid release service is used; GitHub Actions runs the workflow.
