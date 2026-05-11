# Contributing

Changes must preserve the ban on booking and portal credential storage. For changes to consent, entitlements, notification delivery, retention, extension permissions, or service contracts, add a failing test first and cover the safe default.

Install the dependencies in [README.md](README.md), activate the Python environment, then run:

```bash
corepack pnpm verify
```

Use synthetic appointments and reserved domains such as `example.com`. Keep personal data and real availability records out of fixtures. Do not add unattended polling.
