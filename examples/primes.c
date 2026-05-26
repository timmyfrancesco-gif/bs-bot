int printf(char *fmt, int n);

int is_prime(int n) {
    if (n < 2) return 0;
    int i;
    for (i = 2; i * i <= n; i++) {
        if (n % i == 0) return 0;
    }
    return 1;
}

int main() {
    int n;
    int count;
    count = 0;
    printf("Primes up to 100:\n", 0);
    for (n = 2; n <= 100; n++) {
        if (is_prime(n)) {
            printf("%d ", n);
            count = count + 1;
        }
    }
    printf("\nTotal: %d primes\n", count);
    return 0;
}
