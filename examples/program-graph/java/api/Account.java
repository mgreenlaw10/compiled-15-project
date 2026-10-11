package bank;

/** Account state. @invariant balance >= 0 */
public final class Account {
    private int balance;

    public Account(int initial) { balance = initial; }

    /**
     * Withdraw a positive amount without overdrawing.
     * @precondition amount > 0
     * @postcondition a rejected withdrawal leaves balance unchanged
     * @side-effect changes the account balance after validation
     * @throws IllegalArgumentException for invalid amounts
     */
    public int withdraw(int amount) {
        assert amount > 0 : "amount must be positive";
        if (amount <= 0 || amount > balance) {
            throw new IllegalArgumentException("invalid withdrawal");
        }
        balance -= amount;
        return balance;
    }

    public int balance() { return balance; }
}
