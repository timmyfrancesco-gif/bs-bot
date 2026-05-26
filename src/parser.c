#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lexer.h"
#include "ast.h"
#include "parser.h"

static Lexer *L;

static Token peek(void)          { return lexer_peek(L); }
static Token adv(void)           { return lexer_next(L); }
static int   check(TkType t)     { return peek().type == t; }
static int   match(TkType t)     { if (check(t)) { adv(); return 1; } return 0; }
static int   is_type(TkType t)   { return t==TK_INT || t==TK_CHAR || t==TK_VOID; }

static Token expect(TkType t) {
    Token tok = adv();
    if (tok.type != t) {
        fprintf(stderr, "line %d: expected '%s', got '%s'\n",
                tok.line, tk_name(t), tk_name(tok.type));
        exit(1);
    }
    return tok;
}

static Node *alloc(NodeKind k) {
    Node *n = calloc(1, sizeof *n);
    n->kind = k;
    n->line = peek().line;
    return n;
}

static NodeList *nl(Node *n) {
    NodeList *l = calloc(1, sizeof *l);
    l->node = n;
    return l;
}

static NodeList *nl_append(NodeList **head, NodeList **tail, Node *n) {
    NodeList *item = nl(n);
    if (!*head) *head = *tail = item;
    else { (*tail)->next = item; *tail = item; }
    return item;
}

/* ── forward decls ── */
static Node *parse_stmt(void);
static Node *parse_expr(void);
static Node *parse_block(void);

/* ── expressions (recursive descent by precedence) ── */

static Node *parse_primary(void) {
    Token t = peek(); int line = t.line;

    if (t.type == TK_NUM) {
        adv();
        Node *n = alloc(ND_NUM); n->line = line;
        n->num = atol(t.text);
        return n;
    }
    if (t.type == TK_STR) {
        adv();
        Node *n = alloc(ND_STR); n->line = line;
        n->str = t.text;
        return n;
    }
    if (t.type == TK_IDENT) {
        adv();
        if (check(TK_LPAREN)) {
            adv();
            Node *n = alloc(ND_CALL); n->line = line;
            n->call_name = t.text;
            NodeList *head = NULL, *tail = NULL;
            while (!check(TK_RPAREN) && !check(TK_EOF)) {
                nl_append(&head, &tail, parse_expr());
                if (!match(TK_COMMA)) break;
            }
            expect(TK_RPAREN);
            n->call_args = head;
            return n;
        }
        Node *n = alloc(ND_IDENT); n->line = line;
        n->ident = t.text;
        return n;
    }
    if (t.type == TK_LPAREN) {
        adv();
        Node *n = parse_expr();
        expect(TK_RPAREN);
        return n;
    }
    fprintf(stderr, "line %d: unexpected '%s' in expression\n", line, tk_name(t.type));
    exit(1);
}

static Node *parse_postfix(void) {
    Node *n = parse_primary();
    for (;;) {
        int line = peek().line;
        if (check(TK_LBRACK)) {
            adv();
            Node *nd = alloc(ND_INDEX); nd->line = line;
            nd->arr = n; nd->idx = parse_expr();
            expect(TK_RBRACK);
            n = nd;
        } else if (check(TK_INC)) {
            adv();
            Node *nd = alloc(ND_INC); nd->line = line;
            nd->operand = n; nd->post = 1; n = nd;
        } else if (check(TK_DEC)) {
            adv();
            Node *nd = alloc(ND_DEC); nd->line = line;
            nd->operand = n; nd->post = 1; n = nd;
        } else break;
    }
    return n;
}

static Node *parse_unary(void) {
    int line = peek().line;
    if (check(TK_MINUS)) {
        adv(); Node *n = alloc(ND_UNOP); n->line = line;
        strcpy(n->op, "-"); n->expr = parse_unary(); return n;
    }
    if (check(TK_NOT)) {
        adv(); Node *n = alloc(ND_UNOP); n->line = line;
        strcpy(n->op, "!"); n->expr = parse_unary(); return n;
    }
    if (check(TK_AMP)) {
        adv(); Node *n = alloc(ND_UNOP); n->line = line;
        strcpy(n->op, "&"); n->expr = parse_unary(); return n;
    }
    if (check(TK_STAR)) {
        adv(); Node *n = alloc(ND_UNOP); n->line = line;
        strcpy(n->op, "*"); n->expr = parse_unary(); return n;
    }
    if (check(TK_INC)) {
        adv(); Node *n = alloc(ND_INC); n->line = line;
        n->operand = parse_unary(); n->post = 0; return n;
    }
    if (check(TK_DEC)) {
        adv(); Node *n = alloc(ND_DEC); n->line = line;
        n->operand = parse_unary(); n->post = 0; return n;
    }
    return parse_postfix();
}

#define BINOP(name, next, ...) \
static Node *name(void) { \
    Node *n = next(); \
    for (;;) { \
        Token t = peek(); int line = t.line; \
        TkType tys[] = { __VA_ARGS__, TK_EOF }; \
        int ok = 0; for (int i = 0; tys[i] != TK_EOF; i++) if (t.type == tys[i]) { ok=1; break; } \
        if (!ok) { break; } adv(); \
        Node *nd = alloc(ND_BINOP); nd->line = line; \
        nd->lhs = n; nd->rhs = next(); \
        strncpy(nd->op, tk_name(t.type), 3); nd->op[3] = 0; \
        n = nd; \
    } \
    return n; \
}

BINOP(parse_mul, parse_unary,  TK_STAR, TK_SLASH, TK_MOD)
BINOP(parse_add, parse_mul,    TK_PLUS, TK_MINUS)
BINOP(parse_cmp, parse_add,    TK_LT, TK_GT, TK_LEQ, TK_GEQ)
BINOP(parse_eq,  parse_cmp,    TK_EQ, TK_NEQ)
BINOP(parse_and, parse_eq,     TK_AND)
BINOP(parse_or,  parse_and,    TK_OR)

static Node *parse_assign(void) {
    Node *n = parse_or();
    Token t = peek(); int line = t.line;
    if (t.type==TK_ASSIGN || t.type==TK_PLUSEQ ||
        t.type==TK_MINUSEQ || t.type==TK_STAREQ || t.type==TK_SLASHEQ) {
        adv();
        Node *rhs = parse_assign();
        /* expand compound assignment: a += b  →  a = a + b */
        if (t.type != TK_ASSIGN) {
            Node *bin = alloc(ND_BINOP); bin->line = line;
            bin->lhs = n; bin->rhs = rhs;
            if (t.type==TK_PLUSEQ)  strcpy(bin->op, "+");
            if (t.type==TK_MINUSEQ) strcpy(bin->op, "-");
            if (t.type==TK_STAREQ)  strcpy(bin->op, "*");
            if (t.type==TK_SLASHEQ) strcpy(bin->op, "/");
            rhs = bin;
        }
        Node *nd = alloc(ND_ASSIGN); nd->line = line;
        nd->lhs = n; nd->rhs = rhs; strcpy(nd->op, "=");
        return nd;
    }
    return n;
}

static Node *parse_expr(void) { return parse_assign(); }

/* ── statements ── */

static Node *parse_vardecl_tail(int line) {
    /* called after consuming type; parse: name [arr] [= init] ; */
    Token name = expect(TK_IDENT);
    Node *n = alloc(ND_VARDECL); n->line = line;
    n->var_name = name.text;
    if (check(TK_LBRACK)) {
        adv();
        if (check(TK_NUM)) { Token sz = adv(); n->var_arr = atoi(sz.text); }
        else n->var_arr = -1; /* open array (parameter) */
        expect(TK_RBRACK);
    }
    if (match(TK_ASSIGN)) n->var_init = parse_expr();
    expect(TK_SEMI);
    return n;
}

static Node *parse_block(void) {
    expect(TK_LBRACE);
    Node *n = alloc(ND_BLOCK);
    NodeList *head = NULL, *tail = NULL;
    while (!check(TK_RBRACE) && !check(TK_EOF))
        nl_append(&head, &tail, parse_stmt());
    expect(TK_RBRACE);
    n->stmts = head;
    return n;
}

static Node *parse_stmt(void) {
    Token t = peek(); int line = t.line;

    if (is_type(t.type)) { adv(); return parse_vardecl_tail(line); }
    if (t.type == TK_LBRACE) return parse_block();

    if (t.type == TK_IF) {
        adv();
        Node *n = alloc(ND_IF); n->line = line;
        expect(TK_LPAREN); n->cond = parse_expr(); expect(TK_RPAREN);
        n->then = parse_stmt();
        if (check(TK_ELSE)) { adv(); n->alt = parse_stmt(); }
        return n;
    }
    if (t.type == TK_WHILE) {
        adv();
        Node *n = alloc(ND_WHILE); n->line = line;
        expect(TK_LPAREN); n->cond = parse_expr(); expect(TK_RPAREN);
        n->body = parse_stmt();
        return n;
    }
    if (t.type == TK_FOR) {
        adv();
        Node *n = alloc(ND_FOR); n->line = line;
        expect(TK_LPAREN);
        /* init */
        if (!check(TK_SEMI)) {
            if (is_type(peek().type)) { adv(); n->init = parse_vardecl_tail(line); }
            else {
                Node *es = alloc(ND_EXPR_STMT); es->expr = parse_expr();
                n->init = es; expect(TK_SEMI);
            }
        } else adv();
        /* cond */
        if (!check(TK_SEMI)) n->cond = parse_expr();
        expect(TK_SEMI);
        /* step */
        if (!check(TK_RPAREN)) {
            Node *es = alloc(ND_EXPR_STMT); es->expr = parse_expr();
            n->step = es;
        }
        expect(TK_RPAREN);
        n->body = parse_stmt();
        return n;
    }
    if (t.type == TK_RETURN) {
        adv();
        Node *n = alloc(ND_RETURN); n->line = line;
        if (!check(TK_SEMI)) n->expr = parse_expr();
        expect(TK_SEMI);
        return n;
    }
    if (t.type == TK_BREAK)    { adv(); expect(TK_SEMI); return alloc(ND_BREAK); }
    if (t.type == TK_CONTINUE) { adv(); expect(TK_SEMI); return alloc(ND_CONTINUE); }

    /* expression statement */
    Node *n = alloc(ND_EXPR_STMT); n->line = line;
    n->expr = parse_expr();
    expect(TK_SEMI);
    return n;
}

/* ── top-level ── */

Node *parse(Lexer *l) {
    L = l;
    Node *prog = alloc(ND_PROGRAM);
    NodeList *head = NULL, *tail = NULL;

    while (!check(TK_EOF)) {
        /* skip preprocessor directives (we don't implement them) */
        if (!is_type(peek().type)) {
            Token bad = adv();
            fprintf(stderr, "line %d: unexpected '%s' at top level\n",
                    bad.line, tk_name(bad.type));
            exit(1);
        }
        int line = peek().line;
        adv(); /* consume type */
        Token name = expect(TK_IDENT);

        /* skip pointer stars in return type: int *foo(...) */
        while (check(TK_STAR)) adv();

        if (check(TK_LPAREN)) {
            adv(); /* consume '(' */
            /* parse parameter list */
            Param *phead = NULL, *ptail = NULL;
            while (!check(TK_RPAREN) && !check(TK_EOF)) {
                if (is_type(peek().type)) adv(); else break;
                if (check(TK_RPAREN)) break;      /* void param list */
                while (check(TK_STAR)) adv();     /* skip pointer stars */
                if (!check(TK_IDENT)) { if (!match(TK_COMMA)) break; continue; }
                Token pn = adv();
                Param *p = calloc(1, sizeof *p); p->name = pn.text;
                if (check(TK_LBRACK)) { adv(); if(check(TK_RBRACK))adv(); p->is_array=1; }
                if (!phead) phead = ptail = p; else { ptail->next = p; ptail = p; }
                if (!match(TK_COMMA)) break;
            }
            expect(TK_RPAREN);

            /* prototype (declaration only) → skip */
            if (check(TK_SEMI)) { adv(); continue; }

            /* function definition */
            Node *fn = alloc(ND_FUNC); fn->line = line;
            fn->fn_name   = name.text;
            fn->fn_params = phead;
            fn->fn_body   = parse_block();
            nl_append(&head, &tail, fn);
            continue;
        }

        {
            /* global variable */
            Node *vd = alloc(ND_VARDECL); vd->line = line;
            vd->var_name = name.text;
            if (check(TK_LBRACK)) {
                adv();
                if (check(TK_NUM)) { Token sz = adv(); vd->var_arr = atoi(sz.text); }
                expect(TK_RBRACK);
            }
            if (match(TK_ASSIGN)) vd->var_init = parse_expr();
            expect(TK_SEMI);
            nl_append(&head, &tail, vd);
        }
    }
    prog->stmts = head;
    return prog;
}
