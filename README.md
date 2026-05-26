# cc — A C Compiler written in C

A self-contained compiler for a subset of C that produces native x86-64 Linux executables.

## Build

```bash
make
```

Requires `gcc` (used only to assemble and link the generated assembly).

## Usage

```bash
./cc input.c -o output
./output
```

## Examples

```bash
make test          # runs all three examples
./cc examples/hello.c -o hello && ./hello
./cc examples/fibonacci.c -o fib && ./fib
./cc examples/primes.c -o primes && ./primes
```

## Supported C subset

| Feature             | Supported |
|---------------------|-----------|
| `int`, `char`, `void` types | ✅ |
| Local & global variables | ✅ |
| Arrays (`int a[N]`) | ✅ |
| Pointers (`int *p`, `&x`, `*p`) | ✅ |
| Functions (recursive) | ✅ |
| Function prototypes | ✅ (skipped) |
| `if` / `else`       | ✅ |
| `while`             | ✅ |
| `for`               | ✅ |
| `break` / `continue`| ✅ |
| `return`            | ✅ |
| Arithmetic `+ - * / %` | ✅ |
| Comparison `== != < > <= >=` | ✅ |
| Logical `&& \|\| !` | ✅ |
| Assignment `= += -= *= /=` | ✅ |
| `++` / `--` (pre & post) | ✅ |
| String literals     | ✅ |
| `//` and `/* */` comments | ✅ |
| `printf` (via libc) | ✅ |

## Architecture

```
src/
  lexer.c/h    — tokenizer (handles all C operators, keywords, literals)
  parser.c/h   — recursive descent parser → AST
  ast.h        — AST node definitions
  codegen.c/h  — x86-64 AT&T assembly code generator
  main.c       — driver (reads file, runs pipeline, calls gcc to link)
```

The compiler performs:
1. **Lexing** — tokenizes the source file
2. **Parsing** — builds an Abstract Syntax Tree via recursive descent
3. **Code generation** — walks the AST and emits x86-64 AT&T assembly
4. **Assembly + linking** — calls `gcc` on the generated `.s` file

Generated code follows the **System V AMD64 ABI** (arguments in rdi, rsi, rdx, rcx, r8, r9; return value in rax).
