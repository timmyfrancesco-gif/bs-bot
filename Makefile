CC      = gcc
CFLAGS  = -Wall -Wextra -std=c99 -g -Isrc
SRCS    = src/main.c src/lexer.c src/parser.c src/codegen.c
TARGET  = cc

all: $(TARGET)

$(TARGET): $(SRCS)
	$(CC) $(CFLAGS) -o $@ $^

clean:
	rm -f $(TARGET) a.out /tmp/cc_*.s

# Run all examples
test: $(TARGET)
	@echo "=== hello ==="
	./$(TARGET) examples/hello.c -o /tmp/hello && /tmp/hello
	@echo "=== fibonacci ==="
	./$(TARGET) examples/fibonacci.c -o /tmp/fib && /tmp/fib
	@echo "=== primes ==="
	./$(TARGET) examples/primes.c -o /tmp/primes && /tmp/primes

.PHONY: all clean test
