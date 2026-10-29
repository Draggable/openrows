# Security policy

## Supported versions

Security fixes go into the latest release and the `main` branch. Self-hosters should run the
latest release and upgrade when a fix is announced; older releases don't get backports.

The hosted service at [app.openrows.io](https://app.openrows.io) always runs the latest code.

## Reporting a vulnerability

Please don't open a public issue, discussion or pull request for a vulnerability. Report it
privately, either way:

- through GitHub: the repository's **Security** tab → **Report a vulnerability**
  ([private vulnerability reporting](https://github.com/Draggable/openrows/security/advisories/new));
- by email to [support@openrows.io](mailto:support@openrows.io), with "Security" in the subject.

Include what you found, the affected version or commit, the steps to reproduce it and the impact
you expect. We'll acknowledge your report, keep you informed while we fix it,
and credit you in the advisory unless you'd rather not be named. Please give us a reasonable time
to release a fix before you disclose the issue publicly.

## Scope

In scope: the code in this repository and the hosted service at app.openrows.io. Out of scope:
denial of service through sheer volume, social engineering, and findings that need an already
compromised device or server. Test only against your own accounts and data, and don't access,
change or delete other people's data. For the hosted service, don't run automated scanners at a
rate that degrades it.
