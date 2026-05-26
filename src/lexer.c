#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "lexer.h"

struct Lexer {
    const char *src;
    int         pos;
    int         line;
    Token       look;
    int         has_look;
};

Lexer *lexer_new(const char *src) {
    Lexer *l = calloc(1, sizeof *l);
    l->src  = src;
    l->line = 1;
    return l;
}
void lexer_free(Lexer *l) { free(l); }

static void skip(Lexer *l) {
    for (;;) {
        /* whitespace */
        while (l->src[l->pos] && isspace((unsigned char)l->src[l->pos])) {
            if (l->src[l->pos] == '\n') l->line++;
            l->pos++;
        }
        /* // comment */
        if (l->src[l->pos] == '/' && l->src[l->pos+1] == '/') {
            while (l->src[l->pos] && l->src[l->pos] != '\n') l->pos++;
            continue;
        }
        /* block comment */
        if (l->src[l->pos] == '/' && l->src[l->pos+1] == '*') {
            l->pos += 2;
            while (l->src[l->pos]) {
                if (l->src[l->pos] == '\n') l->line++;
                if (l->src[l->pos] == '*' && l->src[l->pos+1] == '/') {
                    l->pos += 2; break;
                }
                l->pos++;
            }
            continue;
        }
        break;
    }
}

static Token mktok(TkType t, char *text, int line) {
    Token tok = { t, text, line };
    return tok;
}

static struct { const char *kw; TkType t; } KWS[] = {
    {"int",      TK_INT},   {"char",     TK_CHAR},  {"void",     TK_VOID},
    {"if",       TK_IF},    {"else",     TK_ELSE},  {"while",    TK_WHILE},
    {"for",      TK_FOR},   {"return",   TK_RETURN},{"break",    TK_BREAK},
    {"continue", TK_CONTINUE}, {NULL, 0}
};

static Token lex_one(Lexer *l) {
    skip(l);
    int line = l->line;
    char c = l->src[l->pos];
    if (!c) return mktok(TK_EOF, NULL, line);

    /* integer literal */
    if (isdigit((unsigned char)c)) {
        int start = l->pos;
        while (isdigit((unsigned char)l->src[l->pos])) l->pos++;
        int len = l->pos - start;
        char *s = malloc(len + 1);
        memcpy(s, l->src + start, len); s[len] = 0;
        return mktok(TK_NUM, s, line);
    }

    /* string literal */
    if (c == '"') {
        l->pos++;
        char *buf = malloc(4096); int bi = 0;
        while (l->src[l->pos] && l->src[l->pos] != '"') {
            if (l->src[l->pos] == '\\') {
                l->pos++;
                switch (l->src[l->pos]) {
                    case 'n':  buf[bi++] = '\n'; break;
                    case 't':  buf[bi++] = '\t'; break;
                    case '\\': buf[bi++] = '\\'; break;
                    case '"':  buf[bi++] = '"';  break;
                    case '0':  buf[bi++] = '\0'; break;
                    default:   buf[bi++] = l->src[l->pos]; break;
                }
            } else {
                buf[bi++] = l->src[l->pos];
            }
            l->pos++;
        }
        buf[bi] = 0;
        if (l->src[l->pos] == '"') l->pos++;
        return mktok(TK_STR, buf, line);
    }

    /* char literal */
    if (c == '\'') {
        l->pos++;
        int val = l->src[l->pos];
        if (l->src[l->pos] == '\\') {
            l->pos++;
            switch (l->src[l->pos]) {
                case 'n': val = '\n'; break; case 't': val = '\t'; break;
                case '0': val = 0;   break; default: val = l->src[l->pos]; break;
            }
        }
        l->pos++;
        if (l->src[l->pos] == '\'') l->pos++;
        char *s = malloc(8); snprintf(s, 8, "%d", val);
        return mktok(TK_NUM, s, line);
    }

    /* identifier or keyword */
    if (isalpha((unsigned char)c) || c == '_') {
        int start = l->pos;
        while (isalnum((unsigned char)l->src[l->pos]) || l->src[l->pos] == '_') l->pos++;
        int len = l->pos - start;
        char *s = malloc(len + 1);
        memcpy(s, l->src + start, len); s[len] = 0;
        for (int i = 0; KWS[i].kw; i++) {
            if (!strcmp(s, KWS[i].kw)) { free(s); return mktok(KWS[i].t, NULL, line); }
        }
        return mktok(TK_IDENT, s, line);
    }

    /* operators / punctuation */
    l->pos++;
    char n = l->src[l->pos];
    switch (c) {
        case '+': if (n=='+'){l->pos++;return mktok(TK_INC,NULL,line);}
                  if (n=='='){l->pos++;return mktok(TK_PLUSEQ,NULL,line);}
                  return mktok(TK_PLUS,NULL,line);
        case '-': if (n=='-'){l->pos++;return mktok(TK_DEC,NULL,line);}
                  if (n=='='){l->pos++;return mktok(TK_MINUSEQ,NULL,line);}
                  return mktok(TK_MINUS,NULL,line);
        case '*': if (n=='='){l->pos++;return mktok(TK_STAREQ,NULL,line);}
                  return mktok(TK_STAR,NULL,line);
        case '/': if (n=='='){l->pos++;return mktok(TK_SLASHEQ,NULL,line);}
                  return mktok(TK_SLASH,NULL,line);
        case '%': return mktok(TK_MOD,NULL,line);
        case '&': if (n=='&'){l->pos++;return mktok(TK_AND,NULL,line);}
                  return mktok(TK_AMP,NULL,line);
        case '|': if (n=='|'){l->pos++;return mktok(TK_OR,NULL,line);}
                  fprintf(stderr,"line %d: unexpected '|'\n",line); exit(1);
        case '!': if (n=='='){l->pos++;return mktok(TK_NEQ,NULL,line);}
                  return mktok(TK_NOT,NULL,line);
        case '=': if (n=='='){l->pos++;return mktok(TK_EQ,NULL,line);}
                  return mktok(TK_ASSIGN,NULL,line);
        case '<': if (n=='='){l->pos++;return mktok(TK_LEQ,NULL,line);}
                  return mktok(TK_LT,NULL,line);
        case '>': if (n=='='){l->pos++;return mktok(TK_GEQ,NULL,line);}
                  return mktok(TK_GT,NULL,line);
        case '(': return mktok(TK_LPAREN,NULL,line);
        case ')': return mktok(TK_RPAREN,NULL,line);
        case '{': return mktok(TK_LBRACE,NULL,line);
        case '}': return mktok(TK_RBRACE,NULL,line);
        case '[': return mktok(TK_LBRACK,NULL,line);
        case ']': return mktok(TK_RBRACK,NULL,line);
        case ';': return mktok(TK_SEMI,NULL,line);
        case ',': return mktok(TK_COMMA,NULL,line);
        default:
            fprintf(stderr,"line %d: unknown char '%c'\n",line,c); exit(1);
    }
}

Token lexer_next(Lexer *l) {
    if (l->has_look) { l->has_look = 0; return l->look; }
    return lex_one(l);
}
Token lexer_peek(Lexer *l) {
    if (!l->has_look) { l->look = lex_one(l); l->has_look = 1; }
    return l->look;
}

const char *tk_name(TkType t) {
    switch (t) {
        case TK_NUM: return "NUM"; case TK_STR: return "STR";
        case TK_IDENT: return "IDENT";
        case TK_INT: return "int"; case TK_CHAR: return "char";
        case TK_VOID: return "void"; case TK_IF: return "if";
        case TK_ELSE: return "else"; case TK_WHILE: return "while";
        case TK_FOR: return "for"; case TK_RETURN: return "return";
        case TK_BREAK: return "break"; case TK_CONTINUE: return "continue";
        case TK_PLUS: return "+"; case TK_MINUS: return "-";
        case TK_STAR: return "*"; case TK_SLASH: return "/";
        case TK_MOD: return "%"; case TK_AMP: return "&";
        case TK_EQ: return "=="; case TK_NEQ: return "!=";
        case TK_LT: return "<"; case TK_GT: return ">";
        case TK_LEQ: return "<="; case TK_GEQ: return ">=";
        case TK_AND: return "&&"; case TK_OR: return "||";
        case TK_NOT: return "!"; case TK_ASSIGN: return "=";
        case TK_PLUSEQ: return "+="; case TK_MINUSEQ: return "-=";
        case TK_STAREQ: return "*="; case TK_SLASHEQ: return "/=";
        case TK_INC: return "++"; case TK_DEC: return "--";
        case TK_LPAREN: return "("; case TK_RPAREN: return ")";
        case TK_LBRACE: return "{"; case TK_RBRACE: return "}";
        case TK_LBRACK: return "["; case TK_RBRACK: return "]";
        case TK_SEMI: return ";"; case TK_COMMA: return ",";
        case TK_EOF: return "EOF";
        default: return "?";
    }
}
