#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "lexer.h"
#include "parser.h"
#include "codegen.h"

static char *read_file(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) { perror(path); exit(1); }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    rewind(f);
    char *buf = malloc(len + 1);
    fread(buf, 1, len, f);
    buf[len] = 0;
    fclose(f);
    return buf;
}

static void usage(void) {
    fprintf(stderr,
        "Usage: cc <input.c> [-o <output>]\n"
        "  Compiles a C subset to a native executable.\n"
        "  Requires gcc (used to assemble and link).\n");
    exit(1);
}

int main(int argc, char **argv) {
    const char *infile  = NULL;
    const char *outfile = "a.out";

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-o") && i+1 < argc) outfile = argv[++i];
        else if (argv[i][0] != '-')               infile  = argv[i];
        else usage();
    }
    if (!infile) usage();

    /* read source */
    char *src = read_file(infile);

    /* lex → parse → codegen */
    Lexer *lex  = lexer_new(src);
    Node  *prog = parse(lex);

    /* write assembly to a temp file */
    char asm_path[] = "/tmp/cc_XXXXXX.s";
    /* mkstemp variant for .s files */
    int fd = -1;
    char tmp[64];
    snprintf(tmp, sizeof tmp, "/tmp/cc_%d.s", (int)getpid());
    FILE *asm_f = fopen(tmp, "w");
    if (!asm_f) { perror("fopen tmp"); exit(1); }
    (void)fd; (void)asm_path;

    codegen(prog, asm_f);
    fclose(asm_f);

    /* assemble and link via gcc */
    char cmd[512];
    snprintf(cmd, sizeof cmd, "gcc -o %s %s", outfile, tmp);
    int rc = system(cmd);
    remove(tmp);

    if (rc != 0) {
        fprintf(stderr, "Assembler/linker error (exit %d)\n", rc);
        exit(1);
    }

    lexer_free(lex);
    free(src);
    printf("Compiled '%s' → '%s'\n", infile, outfile);
    return 0;
}
