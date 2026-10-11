#include "../payments/payment.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    Account account = {100};
    assert(payment_charge(&account, 25) == 75);
    assert(payment_charge(&account, 10) == 65);
    assert(payment_charge(&account, 101) == -1);
    assert(account.balance == 65);
    puts("C contract examples passed");
    return 0;
}
