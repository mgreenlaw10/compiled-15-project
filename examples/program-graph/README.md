# Program graph examples

Open `java/` or `c/` in Cartograph. Java's account, payment and test components
share one package but have separate functional roles. C's account header and
implementation live in different folders and form one interface/implementation
unit. Includes remain distinct from actual calls.

Double-click a module, then a file, to inspect source structure. Select Account
or the C account module in the inspector to inspect fields, signatures, contracts,
and the pending-change impact list.

Two demonstrations:

1. Change `withdraw` / `account_withdraw`'s amount parameter from `int` to a
   different type. The payment caller is flagged. Generation stages signature
   changes; caller adaptations that need implementation reasoning remain partial
   unless the AI transformer completes them. Compilation reports inconsistencies.
2. Edit the source assertion contract from `amount > 0` to `amount > 10` without
   changing the signature. Generation changes the actual assertion expression.
   The payment component is flagged as potentially affected. Its documented
   reliance on rejected-withdrawal atomicity is explicitly recorded for the
   postcondition; no inference is promoted to proof.
   Compilation still passes, but the existing payment test passes `10` and now
   fails with assertions enabled. The validation report exposes this behavioral
   incompatibility even though the signature is unchanged.

The projects' `cartograph.validation.json` files enable assertion-based tests.
Java checks need `javac` and `java`; C checks need GCC. Missing tools are reported
as skipped. Existing tests cover successful withdrawal and rejected-overdraw
atomicity; they do not prove every possible behavior or every desired contract.
