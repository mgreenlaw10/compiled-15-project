#include "../include/account.h"
#include <assert.h>

/** @precondition amount > 0 */
int account_withdraw(Account *account, int amount) {
    assert(amount > 0);
    if (amount <= 0 || amount > account->balance) return -1;
    account->balance -= amount;
    return account->balance;
}
