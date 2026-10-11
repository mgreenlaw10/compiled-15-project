#ifndef ACCOUNT_H
#define ACCOUNT_H

/** Account storage. @invariant balance >= 0 */
typedef struct Account {
    int balance;
} Account;

/** Withdraw money. @postcondition a rejected withdrawal leaves balance unchanged */
int account_withdraw(Account *account, int amount);

#endif
