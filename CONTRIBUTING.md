# Contributing to HTMLTrust e2e

Issues and pull requests are welcome. Open an issue first for anything
substantial, so the approach can be agreed before you spend time on it.

## Licensing your contribution

This project uses the [Developer Certificate of Origin](DCO), not a contributor
licence agreement. There is nothing to sign and nobody to email. You keep the
copyright in what you write.

Sign off each commit, which certifies you have the right to submit it under the
project's licence:

```sh
git commit -s -m "your message"
```

That adds a `Signed-off-by: Your Name <you@example.com>` trailer. Use a real
name and a real address. The full text of what you are certifying is in
[DCO](DCO); it is four short clauses and worth reading once.

Your contribution is licensed to the project on the same terms the project uses,
which is the Apache License 2.0 in `LICENSE`. That includes
the patent grant in section 3, which is what makes the code safe for others
to implement against. No additional rights are transferred, and there is no
copyright assignment.

One consequence worth stating plainly: because contributors keep their
copyright, changing the project's licence later would need the agreement of
everyone who has contributed. That is the deliberate trade for having no CLA to
sign, and it is why the licence was settled before inviting contributions.

## Verifying sign-off locally

```sh
git log --format='%h %s%n    %(trailers:key=Signed-off-by)' origin/main..HEAD
```

Every commit in the range should show a trailer. To add one to the last commit:

```sh
git commit --amend -s --no-edit
```
