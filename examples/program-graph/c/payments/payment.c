#include "payment.h"

/** @relies-on account_withdraw:postcondition */
int payment_charge(Account *account, int amount) {
    return account_withdraw(account, amount);
}
