#pragma once

typedef enum {
    TK_NUM, TK_STR, TK_IDENT,
    /* keywords */
    TK_INT, TK_CHAR, TK_VOID,
    TK_IF, TK_ELSE, TK_WHILE, TK_FOR,
    TK_RETURN, TK_BREAK, TK_CONTINUE,
    /* operators */
    TK_PLUS, TK_MINUS, TK_STAR, TK_SLASH, TK_MOD,
    TK_AMP, TK_EQ, TK_NEQ,
    TK_LT, TK_GT, TK_LEQ, TK_GEQ,
    TK_AND, TK_OR, TK_NOT,
    TK_ASSIGN, TK_PLUSEQ, TK_MINUSEQ, TK_STAREQ, TK_SLASHEQ,
    TK_INC, TK_DEC,
    /* punctuation */
    TK_LPAREN, TK_RPAREN, TK_LBRACE, TK_RBRACE,
    TK_LBRACK, TK_RBRACK, TK_SEMI, TK_COMMA,
    TK_EOF,
} TkType;

typedef struct {
    TkType  type;
    char   *text;   /* heap string: value for NUM/STR/IDENT, else NULL */
    int     line;
} Token;

typedef struct Lexer Lexer;

Lexer      *lexer_new(const char *src);
void        lexer_free(Lexer *l);
Token       lexer_next(Lexer *l);
Token       lexer_peek(Lexer *l);
const char *tk_name(TkType t);
