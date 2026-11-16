# Security Policy

## Supported versions

`bitacode` moves fast and only the latest published version is supported.
Please reproduce issues against the current release before reporting.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private reporting:

<https://github.com/soumik183/bitacode/security/advisories/new>

Please include the version, your OS and terminal, what an attacker could do,
and the smallest reproduction you can manage.

You can expect an acknowledgement within a few days. If the report is valid I
will publish a fix and credit you in the advisory unless you prefer otherwise.

## Scope

In scope:

- command injection or sandbox escapes through the bash tool or its approval flow
- path traversal in file tools, skills, or MCP resource loading
- leaked secrets in logs, session files, or transcript output
- prompt injection that causes an unintended tool call to run without approval

Out of scope:

- the agent producing wrong or unsafe *code* in your repository — it is a
  coding assistant, review its output like you would a colleague's
- vulnerabilities in a model provider's API
- anyone with write access to your machine running commands, which the tool is
  explicitly designed to do

## A note on running an agent

`bitacode` executes shell commands and edits files on your behalf. Treat it
like a new contributor with shell access:

- review diffs before accepting them
- keep approval prompts on unless you trust the workflow
- never commit real credentials; `.env` is ignored by default
