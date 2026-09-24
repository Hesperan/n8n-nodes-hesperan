# Publishing n8n-nodes-hesperan

The steps a person has to do to publish this package, get it verified by n8n and submit the templates.
Nothing here has been done yet. Checked against n8n's and npm's documentation on 24 September 2026:
[Submit community nodes](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes),
[Verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).

n8n's rules that shape these steps:

- The npm package's repository URL must point to a **public** GitHub repository, and the package author or
  maintainer must match between npm and that repository.
- From 1 May 2026, nodes submitted for verification must be **published from GitHub Actions with an npm
  provenance statement**; n8n does not accept verified nodes published from a local machine.
- License MIT, no runtime dependencies, README in the package or repository, `npx @n8n/scan-community-package`
  must pass.

## 1. GitHub repository

On 24 September 2026, `github.com/hesperan` and the npm name `n8n-nodes-hesperan` were both still free.

1. Create the GitHub organisation `hesperan` (or change `repository`, `homepage` and `bugs` in `package.json`, the
   URLs in `nodes/Hesperan/Hesperan.node.json` and `credentials/HesperanApi.credentials.ts`, and the owner in step
   3 to wherever the repository lives).
2. Create the **public** repository `hesperan/n8n-nodes-hesperan`, without a README or license (both come from here).
3. Move this directory to the root of that repository, keeping its history, from a checkout of hesperan-web:

   ```bash
   git subtree split --prefix=integrations/n8n-nodes-hesperan -b n8n-nodes-hesperan
   git push git@github.com:hesperan/n8n-nodes-hesperan.git n8n-nodes-hesperan:main
   ```

   `.github/workflows/ci.yml` and `publish.yml` then sit at the repository root, where GitHub runs them.

4. Check that **Actions → CI** passes on `main` (lint, build, tests).
5. Optional but recommended: protect `main` and allow tags matching `*.*.*` to be pushed only by maintainers
   (**Settings → Rules**).

## 2. npm account

1. Create or use the npm account that will own the package, with two-factor authentication on
   (**Account → Two-Factor Authentication**). Use the same identity as on GitHub, e.g. an npm organisation
   `hesperan` or the maintainer's account; `author` in `package.json` is `Hesperan <hello@hesperan.com>`.
2. npm documents trusted publishers as a setting of an existing package. For the **first** release, publish once
   from GitHub Actions with a token:
   - npmjs.com → **Access Tokens → Generate New Token → Granular Access Token**: read and write, all packages
     (the package does not exist yet), short expiry.
   - GitHub → repository **Settings → Secrets and variables → Actions → New repository secret**: `NPM_TOKEN`.

## 3. First release

1. Set the version in `package.json` (currently `0.1.0`) and the date in `CHANGELOG.md`, commit, push.
2. Tag and push; the tag must equal the version (the workflow checks it):

   ```bash
   git tag 0.1.0
   git push origin 0.1.0
   ```

   Alternatively `npm run release` (release-it) bumps the version, writes the changelog, commits, tags, pushes
   and creates a GitHub release; it needs a clean `main` with an upstream.

3. **Actions → Publish** runs `npm ci`, the tests and `npm run release`, which inside GitHub Actions lints,
   builds and runs `npm publish` with `NPM_CONFIG_PROVENANCE=true`.
4. On npmjs.com the version shows a **Provenance** badge linking to the workflow run and commit.
5. Run n8n's check on the published package; it must pass:

   ```bash
   npx @n8n/scan-community-package n8n-nodes-hesperan
   ```

## 4. Switch to trusted publishing

1. npmjs.com → package `n8n-nodes-hesperan` → **Settings → Trusted Publisher → GitHub Actions**:
   - Organization or user: `hesperan`
   - Repository: `n8n-nodes-hesperan`
   - Workflow filename: `publish.yml`
   - Environment: leave empty
2. Delete the `NPM_TOKEN` secret in GitHub and revoke the token on npm.
3. Package **Settings → Publishing access**: _Require two-factor authentication and disallow tokens_.
4. From now on a pushed version tag publishes through OIDC; provenance is added automatically.

## 5. Try it in n8n

In a test n8n instance: **Settings → Community Nodes → Install** → `n8n-nodes-hesperan`. Add a Hesperan
credential with a real key (the test calls the free `GET /v1/me`), import `templates/zammad-ticket-triage.json`,
and check Decide on a calibrated profile: Auto, Review, and the error shown while the API still answers 503
"opens soon".

## 6. Submit the node for verification

1. Sign up or log in at the [n8n Creator Portal](https://creators.n8n.io/nodes).
2. Submit the npm package `n8n-nodes-hesperan`. n8n fetches it from npm and reviews code, UX and documentation
   against the [verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines)
   and the [UX guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines).
3. Answer review feedback with a new version (steps 3 and 4 publish it) and resubmit if asked.

Points a reviewer may ask about:

- The Decide output count depends on the operation (two outputs, _Auto_ and _Review_; Ask can have one output per
  option), set with an `outputs` expression like n8n's Switch node. The node integrates one service and is not a
  generic flow-control node, which n8n does not accept at the moment.
- The credential test uses `GET /v1/me`, an authenticated endpoint that is free and does not call the model.

## 7. Submit the templates

1. In the [n8n Creator Portal](https://creators.n8n.io/login), open the template section and read its current
   template guidelines (title, description, sticky notes in English).
2. Import each file from `templates/` into an n8n instance where the verified node is installed, connect real
   credentials once to check it runs, remove them again, and export or submit from there.
3. Submit `zammad-ticket-triage.json`, `zammad-outcome-feedback.json`, `mailbox-triage-imap.json` and
   `mailbox-triage-gmail.json`, each with a short description that only names the nodes the workflow contains.

Templates that use a community node are only useful to people who can install it, so submit them after the node
is verified. Whether the template library accepts community nodes before verification is not documented.
