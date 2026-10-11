package bank;

public final class ContractTest {
    public static void main(String[] args) {
        Account account = new Account(100);
        PaymentService payments = new PaymentService(account);
        assert payments.pay(25) == 75;
        assert payments.pay(10) == 65;
        try {
            payments.pay(101);
            throw new AssertionError("overdraw accepted");
        } catch (IllegalArgumentException expected) {
            assert account.balance() == 65 : "rejected withdrawal mutated balance";
        }
        System.out.println("Java contract examples passed");
    }
}
