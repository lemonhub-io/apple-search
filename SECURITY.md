# Security

## Reporting a vulnerability

Please **do not** open a public issue. Email the maintainer via the address
on the [lemonhub-io](https://github.com/lemonhub-io) profile, or use
GitHub's private vulnerability reporting on this repository.

Include: affected endpoint/component, reproduction steps, and impact.

## Scope notes

- `/api/search` is a public proxy — it never exposes `LANGSEARCH_API_KEY`
  (the secret lives only in Worker bindings).
- Results come from a third-party index; treat all result content as
  untrusted external data.
- Dependencies are pinned and at least a week old at introduction; CI
  deploys straight from `main`.
