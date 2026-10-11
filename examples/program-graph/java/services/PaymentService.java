package bank;

public final class PaymentService {
    private final Account account;

    public PaymentService(Account account) { this.account = account; }

    /**
     * Charge an account, preserving its balance if the withdrawal is rejected.
     * @relies-on bank.Account.withdraw:postcondition
     */
    public int pay(int amount) { return account.withdraw(amount); }
}
