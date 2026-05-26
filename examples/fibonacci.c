int printf(char *fmt, int n);

int fib(int n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
}

int main() {
    int i;
    for (i = 0; i <= 15; i++) {
        printf("fib(%d) = ", i);
        printf("%d\n", fib(i));
    }
    return 0;
}
