<div align="center">
  <img src="docs/cover.png" alt="Slot Signal" width="100%">
  <p><strong>Consent-aware reporting and review for appointment-availability signals.</strong></p>
  <p>
    <a href="#why-slot-signal">Why</a> ·
    <a href="#system-map">System map</a> ·
    <a href="#local-setup">Local setup</a> ·
    <a href="#verification">Verification</a> ·
    <a href="#safety-boundary">Safety boundary</a>
  </p>
  <p>
    <img alt="Status: consent-aware local prototype" src="https://img.shields.io/badge/status-local_prototype-64748b">
    <img alt="Node.js 20 through 24" src="https://img.shields.io/badge/node-20%E2%80%9324-339933">
    <img alt="Python 3.11 or newer" src="https://img.shields.io/badge/python-3.11%2B-3776AB">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-16a34a">
  </p>
</div>

Slot Signal is a prototype for reviewing community reports of appointment availability. It combines a FastAPI service, shared TypeScript contracts, a Chrome side panel, and a small public site so consent, reporting, notification, audit, and retention behavior can be tested together.

The project does not book appointments, store portal credentials, or run unattended availability polling. Live notification delivery is disabled by default.

## Why Slot Signal

Appointment availability is easy to overstate. A user may see an open time that disappears moments later, a report may be stale, and a notification can be mistaken for a confirmed reservation. Browser automation also creates a strong temptation to cross from observation into credential handling or unattended booking.

Slot Signal treats an availability report as a bounded, reviewable signal. The browser surface collects context only while a person is present. Shared contracts define what may cross into the API. The service records report, preference, entitlement, monitoring, delivery, and audit behavior separately. Public-facing copy states the same boundary as the code: the system reports and notifies; it does not reserve.

The current release is meant for reviewing:

- browser-to-service trust boundaries;
- typed contracts shared between TypeScript and Python surfaces;
- consent and notification-preference handling;
- retention, audit, and destruction behavior;
- extension packaging without embedding production credentials.

## System map

| Surface | Responsibility |
| --- | --- |
| FastAPI service | Accepts and reviews availability reports, preferences, and audit events |
| Shared contracts | Keeps API and extension message shapes aligned |
| Chrome side panel | Lets a user submit or review signals while they are actively browsing |
| Extension bridge | Validates messages crossing the browser and application boundary |
| Public site | Explains the workflow and provides a small entry surface |
| Safety tests | Exercise consent, delivery, retention, and prohibited behavior |
| Store build | Produces a reviewable extension artifact without enabling live delivery |

The API and extension are separate on purpose. The browser surface never needs portal credentials, while the service can enforce retention and notification rules independently of page interaction.

## Implemented capabilities

### Shared domain and browser boundary

- Contracts for reports, policy, queue state, notifications, observability, adapters, and extension messages.
- A bridge package that validates the application-facing extension boundary.
- Chrome side-panel, popup, and options surfaces built with WXT and React.
- Local and store build profiles with an artifact check for the distributable extension.

### API and operational behavior

- FastAPI routes for health, reports, entitlements, monitoring, provider delivery, and synthetic end-to-end fixtures.
- Source-adapter and notification-adapter boundaries instead of embedded provider credentials.
- Runtime monitoring and audit-oriented services covered by focused tests.
- Persistence-control and destruction tests that make retention behavior reviewable.

### Public trust surface

- A static site with workflow, access, support, and trust pages.
- Extension documentation for privacy, security, safe use, feedback, and known limitations.
- Link validation and store-build checks included in the repository verification pipeline.

## Local setup

Slot Signal requires Node.js 20–24, Corepack, and Python 3.11 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install './apps/api[dev]'
corepack pnpm install --frozen-lockfile
```

Start the API on loopback:

```bash
python -m uvicorn app.main:app \
  --app-dir apps/api \
  --host 127.0.0.1 \
  --port 8000
```

Open `http://127.0.0.1:8000/docs` to exercise the API with synthetic inputs. Local mode has no authentication and must remain on loopback.

Build the browser extension and public site from another terminal:

```bash
corepack pnpm build
python3 -m http.server 5179 \
  --bind 127.0.0.1 \
  --directory apps/public-site/dist
```

Open `http://127.0.0.1:5179` for the site. To inspect the extension, enable Developer mode at `chrome://extensions` and load `apps/extension/.output/chrome-mv3` as an unpacked extension. Its local profile connects to the API on port 8000.

## Practical usage

Use the OpenAPI page first. It exposes the service contracts without requiring the browser extension and is the clearest place to inspect validation, report state, monitoring records, and synthetic fixture behavior.

The extension is intended for a local review session. Keep the API bound to loopback, load the unpacked build, and use synthetic provider context. The store profile exists to validate packaging and trust-page requirements; its example API origin is not a deployed service.

The public site is a separate static application. It can be reviewed without enabling extension permissions or starting the API. This separation lets contributors work on user-facing explanations without changing the browser or service trust boundary.

## Safety boundary

A report is a user-supplied signal, not a confirmed reservation. The software keeps reporting separate from booking and does not automate interactions with appointment portals.

The repository includes explicit behavior around consent, notification preferences, audit events, and data retention. Those controls make the prototype inspectable; they do not authorize access to a provider or make a local configuration suitable for public exposure.

A live deployment would need authenticated users, approved provider relationships, delivery controls, abuse handling, retention enforcement, and a reviewed privacy policy. Any portal interaction must follow the provider's terms and the user's authority.

## Verification

With the Python environment active:

```bash
corepack pnpm verify
```

The verification pipeline runs TypeScript checks, shared-contract tests, extension safety tests, API tests, builds, store-artifact checks, and website link validation.

## Repository map

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Shared domain, policy, message, queue, adapter, notification, and observability contracts |
| `packages/extension-bridge` | Validated boundary between browser messages and application contracts |
| `apps/api` | FastAPI routes, services, adapters, storage boundaries, schemas, and tests |
| `apps/extension` | Side panel, popup, options, background entry point, and browser trust documentation |
| `apps/public-site` | Static public, access, support, and trust pages |
| `tests/safety-contract.test.mjs` | Cross-workspace prohibited-behavior checks |
| `scripts/check-store-build.mjs` | Review of the extension store artifact |

## Project status

Slot Signal is complete as a consent-aware local prototype and implementation reference. Live notification delivery, hosted identity, production persistence, and provider integrations are intentionally absent. That keeps the public release useful for reviewing the architecture without presenting it as a booking service.

Read [SECURITY.md](SECURITY.md) before changing network or browser boundaries. Contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md).

The current API uses local development assumptions. Do not expose it publicly without authentication, authorization, rate limits, durable migrations, tenant isolation, secret management, retention jobs, abuse controls, and a reviewed delivery provider.

## Contributing, security, and license

Changes to reports, delivery, retention, browser permissions, or provider adapters should include tests for both allowed and prohibited behavior. Keep examples synthetic and do not add portal credentials, personal appointment data, or real provider accounts.

Report authentication bypasses, unsafe browser messaging, retention failures, delivery abuse, or sensitive-data exposure through GitHub's private security-advisory channel.

Slot Signal is available under the [MIT License](LICENSE).
