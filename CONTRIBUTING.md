# Contributing

Use Node.js 20 or later. No dependency installation is needed. Run `npm test`
before submitting a pull request, and keep the application usable without a
tracker connection. Use synthetic fixtures for tests and screenshots.

Do not commit personal notes, ticket exports, caches, local configuration,
credentials or logs. Keep server-only credentials out of browser responses.
Preserve the localhost binding, origin checks, conflict protection and the
separation between private notes and tracker comments.

Author, agent, provider and model fields are attribution supplied by callers;
they are not authentication. Keep old Markdown notes readable.
