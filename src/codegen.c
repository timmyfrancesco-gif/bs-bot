#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ast.h"
#include "codegen.h"

/* ─── output ─────────────────────────────────────────────── */
static FILE *OUT;
static int   LABEL;

static int newlabel(void) { return LABEL++; }
#define emit(...)  fprintf(OUT, __VA_ARGS__)

/* ─── symbol tables ──────────────────────────────────────── */
typedef struct Sym  Sym;
typedef struct GSym GSym;
typedef struct Str  Str;

struct Sym  { char *name; int off; int is_arr; Sym  *next; };
struct GSym { char *name; int is_arr; GSym *next; };
struct Str  { char *val; int id; Str *next; };

static Sym  *locals;
static GSym *globals;
static Str  *strings;
static int   str_id;
static int   local_off;

/* break/continue jump targets */
static int brk_lbl = -1, cont_lbl = -1;

static Sym *find_local(const char *name) {
    for (Sym *s = locals; s; s = s->next)
        if (!strcmp(s->name, name)) return s;
    return NULL;
}
static GSym *find_global(const char *name) {
    for (GSym *g = globals; g; g = g->next)
        if (!strcmp(g->name, name)) return g;
    return NULL;
}
static void push_sym(const char *name, int off, int is_arr) {
    Sym *s = calloc(1, sizeof *s);
    s->name = strdup(name); s->off = off; s->is_arr = is_arr; s->next = locals;
    locals = s;
}
static const char *intern_str(const char *v) {
    for (Str *s = strings; s; s = s->next)
        if (!strcmp(s->val, v)) { char *b = malloc(16); sprintf(b,".Ls%d",s->id); return b; }
    Str *s = calloc(1, sizeof *s);
    s->val = strdup(v); s->id = str_id++;
    s->next = strings; strings = s;
    char *b = malloc(16); sprintf(b, ".Ls%d", s->id); return b;
}

/* ─── pre-compute local variable space ───────────────────── */
static int locals_size(Node *n) {
    if (!n) return 0;
    int s = 0;
    switch (n->kind) {
        case ND_VARDECL: s = (n->var_arr > 0 ? n->var_arr : 1) * 8; break;
        case ND_BLOCK:
            for (NodeList *l = n->stmts; l; l = l->next) s += locals_size(l->node);
            break;
        case ND_IF:
            s += locals_size(n->then) + locals_size(n->alt);
            break;
        case ND_WHILE: s += locals_size(n->body); break;
        case ND_FOR:
            s += locals_size(n->init) + locals_size(n->body);
            break;
        default: break;
    }
    return s;
}

/* ─── code generation ────────────────────────────────────── */
static void gen_expr(Node *n);
static void gen_stmt(Node *n);

/* Emit an lvalue address into %rax */
static void gen_addr(Node *n) {
    switch (n->kind) {
        case ND_IDENT: {
            Sym *s = find_local(n->ident);
            if (s) { emit("    leaq %d(%%rbp), %%rax\n", s->off); return; }
            emit("    leaq %s(%%rip), %%rax\n", n->ident);
            return;
        }
        case ND_INDEX:
            gen_expr(n->idx);
            emit("    pushq %%rax\n");
            gen_addr(n->arr);
            emit("    popq %%rcx\n");
            emit("    imulq $8, %%rcx\n");
            emit("    addq %%rcx, %%rax\n");
            return;
        case ND_UNOP:
            if (!strcmp(n->op, "*")) { gen_expr(n->expr); return; }
            /* fall through */
        default:
            fprintf(stderr, "line %d: not an lvalue\n", n->line); exit(1);
    }
}

static void gen_expr(Node *n) {
    switch (n->kind) {

    case ND_NUM:
        emit("    movq $%ld, %%rax\n", n->num);
        break;

    case ND_STR: {
        const char *lbl = intern_str(n->str);
        emit("    leaq %s(%%rip), %%rax\n", lbl);
        break;
    }

    case ND_IDENT: {
        Sym *s = find_local(n->ident);
        if (s) {
            if (s->is_arr) emit("    leaq %d(%%rbp), %%rax\n", s->off);
            else           emit("    movq %d(%%rbp), %%rax\n", s->off);
            return;
        }
        GSym *g = find_global(n->ident);
        if (g && g->is_arr) emit("    leaq %s(%%rip), %%rax\n", n->ident);
        else                emit("    movq %s(%%rip), %%rax\n", n->ident);
        break;
    }

    case ND_ASSIGN:
        gen_expr(n->rhs);
        emit("    pushq %%rax\n");
        gen_addr(n->lhs);
        emit("    popq %%rcx\n");
        emit("    movq %%rcx, (%%rax)\n");
        emit("    movq %%rcx, %%rax\n");
        break;

    case ND_BINOP: {
        /* evaluate rhs first (push), then lhs */
        gen_expr(n->rhs);
        emit("    pushq %%rax\n");
        gen_expr(n->lhs);
        emit("    popq %%rcx\n");

        if      (!strcmp(n->op,"+"))  emit("    addq %%rcx, %%rax\n");
        else if (!strcmp(n->op,"-"))  emit("    subq %%rcx, %%rax\n");
        else if (!strcmp(n->op,"*"))  emit("    imulq %%rcx, %%rax\n");
        else if (!strcmp(n->op,"/"))  { emit("    cqto\n"); emit("    idivq %%rcx\n"); }
        else if (!strcmp(n->op,"%"))  { emit("    cqto\n"); emit("    idivq %%rcx\n");
                                        emit("    movq %%rdx, %%rax\n"); }
        else if (!strcmp(n->op,"==")) { emit("    cmpq %%rcx, %%rax\n"); emit("    sete %%al\n");  emit("    movzbq %%al, %%rax\n"); }
        else if (!strcmp(n->op,"!=")) { emit("    cmpq %%rcx, %%rax\n"); emit("    setne %%al\n"); emit("    movzbq %%al, %%rax\n"); }
        else if (!strcmp(n->op,"<"))  { emit("    cmpq %%rcx, %%rax\n"); emit("    setl %%al\n");  emit("    movzbq %%al, %%rax\n"); }
        else if (!strcmp(n->op,">"))  { emit("    cmpq %%rcx, %%rax\n"); emit("    setg %%al\n");  emit("    movzbq %%al, %%rax\n"); }
        else if (!strcmp(n->op,"<=")) { emit("    cmpq %%rcx, %%rax\n"); emit("    setle %%al\n"); emit("    movzbq %%al, %%rax\n"); }
        else if (!strcmp(n->op,">=")) { emit("    cmpq %%rcx, %%rax\n"); emit("    setge %%al\n"); emit("    movzbq %%al, %%rax\n"); }
        else if (!strcmp(n->op,"&&")) {
            emit("    testq %%rax, %%rax\n"); emit("    setne %%al\n");
            emit("    testq %%rcx, %%rcx\n"); emit("    setne %%cl\n");
            emit("    andb %%cl, %%al\n");    emit("    movzbq %%al, %%rax\n");
        }
        else if (!strcmp(n->op,"||")) {
            emit("    orq %%rcx, %%rax\n");
            emit("    setne %%al\n"); emit("    movzbq %%al, %%rax\n");
        }
        else { fprintf(stderr,"unknown binop '%s'\n",n->op); exit(1); }
        break;
    }

    case ND_UNOP:
        if (!strcmp(n->op,"-")) { gen_expr(n->expr); emit("    negq %%rax\n"); }
        else if (!strcmp(n->op,"!")) {
            gen_expr(n->expr);
            emit("    testq %%rax, %%rax\n");
            emit("    sete %%al\n"); emit("    movzbq %%al, %%rax\n");
        }
        else if (!strcmp(n->op,"&")) gen_addr(n->expr);
        else if (!strcmp(n->op,"*")) { gen_expr(n->expr); emit("    movq (%%rax), %%rax\n"); }
        break;

    case ND_INDEX:
        gen_expr(n->idx);
        emit("    pushq %%rax\n");
        gen_addr(n->arr);
        emit("    popq %%rcx\n");
        emit("    imulq $8, %%rcx\n");
        emit("    addq %%rcx, %%rax\n");
        emit("    movq (%%rax), %%rax\n");
        break;

    case ND_CALL: {
        /* count args */
        int argc = 0;
        for (NodeList *a = n->call_args; a; a = a->next) argc++;
        /* evaluate args and push them */
        for (NodeList *a = n->call_args; a; a = a->next) {
            gen_expr(a->node);
            emit("    pushq %%rax\n");
        }
        /* pop into argument registers (SysV: rdi, rsi, rdx, rcx, r8, r9) */
        static const char *regs[] = {"%rdi","%rsi","%rdx","%rcx","%r8","%r9"};
        for (int i = argc-1; i >= 0 && i < 6; i--)
            emit("    popq %s\n", regs[i]);
        /* align stack to 16 bytes; if local frame size is 16-aligned and
           no extra pushes remain, we're fine — add one alignment slot to be safe */
        emit("    xorq %%rax, %%rax\n"); /* variadic: 0 fp args */
        emit("    callq %s\n", n->call_name);
        break;
    }

    case ND_INC:
        gen_addr(n->operand);
        emit("    movq %%rax, %%rcx\n");      /* rcx = address */
        emit("    movq (%%rcx), %%rax\n");    /* rax = old value */
        if (n->post) {
            emit("    pushq %%rax\n");         /* save old value */
            emit("    incq (%%rcx)\n");
            emit("    popq %%rax\n");          /* return old value */
        } else {
            emit("    incq (%%rcx)\n");
            emit("    movq (%%rcx), %%rax\n");
        }
        break;

    case ND_DEC:
        gen_addr(n->operand);
        emit("    movq %%rax, %%rcx\n");
        emit("    movq (%%rcx), %%rax\n");
        if (n->post) {
            emit("    pushq %%rax\n");
            emit("    decq (%%rcx)\n");
            emit("    popq %%rax\n");
        } else {
            emit("    decq (%%rcx)\n");
            emit("    movq (%%rcx), %%rax\n");
        }
        break;

    default:
        fprintf(stderr, "line %d: cannot emit expression (kind=%d)\n", n->line, n->kind);
        exit(1);
    }
}

static void gen_stmt(Node *n) {
    if (!n) return;
    switch (n->kind) {

    case ND_VARDECL: {
        /* variable already registered in symbol table by gen_block;
           just emit the initializer if present */
        if (!n->var_init) break;
        Sym *s = find_local(n->var_name);
        if (!s) break;
        gen_expr(n->var_init);
        if (n->var_arr <= 0)
            emit("    movq %%rax, %d(%%rbp)\n", s->off);
        break;
    }

    case ND_BLOCK: {
        /* allocate locals declared directly in this block */
        Sym *saved = locals;
        for (NodeList *l = n->stmts; l; l = l->next) {
            Node *st = l->node;
            if (st->kind == ND_VARDECL) {
                int sz = (st->var_arr > 0 ? st->var_arr : 1) * 8;
                local_off -= sz;
                push_sym(st->var_name, local_off, st->var_arr > 0);
            }
        }
        for (NodeList *l = n->stmts; l; l = l->next)
            gen_stmt(l->node);
        locals = saved; /* restore scope */
        break;
    }

    case ND_IF: {
        int Lelse = newlabel(), Lend = newlabel();
        gen_expr(n->cond);
        emit("    testq %%rax, %%rax\n");
        emit("    jz .L%d\n", Lelse);
        gen_stmt(n->then);
        emit("    jmp .L%d\n", Lend);
        emit(".L%d:\n", Lelse);
        if (n->alt) gen_stmt(n->alt);
        emit(".L%d:\n", Lend);
        break;
    }

    case ND_WHILE: {
        int Lcond = newlabel(), Lend = newlabel();
        int sb = brk_lbl, sc = cont_lbl;
        brk_lbl = Lend; cont_lbl = Lcond;
        emit(".L%d:\n", Lcond);
        gen_expr(n->cond);
        emit("    testq %%rax, %%rax\n");
        emit("    jz .L%d\n", Lend);
        gen_stmt(n->body);
        emit("    jmp .L%d\n", Lcond);
        emit(".L%d:\n", Lend);
        brk_lbl = sb; cont_lbl = sc;
        break;
    }

    case ND_FOR: {
        int Lcond = newlabel(), Lstep = newlabel(), Lend = newlabel();
        int sb = brk_lbl, sc = cont_lbl;
        brk_lbl = Lend; cont_lbl = Lstep;
        Sym *saved = locals;
        /* init (may declare a variable) */
        if (n->init) {
            if (n->init->kind == ND_VARDECL) {
                local_off -= 8;
                push_sym(n->init->var_name, local_off, 0);
                if (n->init->var_init) {
                    gen_expr(n->init->var_init);
                    emit("    movq %%rax, %d(%%rbp)\n", local_off);
                }
            } else gen_stmt(n->init);
        }
        emit(".L%d:\n", Lcond);
        if (n->cond) {
            gen_expr(n->cond);
            emit("    testq %%rax, %%rax\n");
            emit("    jz .L%d\n", Lend);
        }
        gen_stmt(n->body);
        emit(".L%d:\n", Lstep);
        if (n->step) gen_expr(n->step->expr);
        emit("    jmp .L%d\n", Lcond);
        emit(".L%d:\n", Lend);
        locals = saved; brk_lbl = sb; cont_lbl = sc;
        break;
    }

    case ND_RETURN:
        if (n->expr) gen_expr(n->expr);
        else emit("    xorq %%rax, %%rax\n");
        emit("    movq %%rbp, %%rsp\n");
        emit("    popq %%rbp\n");
        emit("    retq\n");
        break;

    case ND_BREAK:
        if (brk_lbl < 0) { fprintf(stderr,"break outside loop\n"); exit(1); }
        emit("    jmp .L%d\n", brk_lbl);
        break;

    case ND_CONTINUE:
        if (cont_lbl < 0) { fprintf(stderr,"continue outside loop\n"); exit(1); }
        emit("    jmp .L%d\n", cont_lbl);
        break;

    case ND_EXPR_STMT:
        gen_expr(n->expr);
        break;

    default:
        fprintf(stderr, "line %d: unhandled statement kind=%d\n", n->line, n->kind);
        exit(1);
    }
}

static void gen_func(Node *fn) {
    locals = NULL; local_off = 0;
    brk_lbl = cont_lbl = -1;

    /* count params */
    int nparams = 0;
    for (Param *p = fn->fn_params; p; p = p->next) nparams++;

    /* total stack space = params + locals; aligned to 16 */
    int lsz = locals_size(fn->fn_body) + nparams * 8 + 64 /* slack */;
    lsz = (lsz + 15) & ~15;

    emit("    .globl %s\n", fn->fn_name);
    emit("    .type  %s, @function\n", fn->fn_name);
    emit("%s:\n", fn->fn_name);
    emit("    pushq %%rbp\n");
    emit("    movq  %%rsp, %%rbp\n");
    if (lsz) emit("    subq  $%d, %%rsp\n", lsz);

    /* save parameters to stack (SysV: rdi rsi rdx rcx r8 r9) */
    static const char *pregs[] = {"%rdi","%rsi","%rdx","%rcx","%r8","%r9"};
    int pi = 0;
    for (Param *p = fn->fn_params; p && pi < 6; p = p->next, pi++) {
        local_off -= 8;
        push_sym(p->name, local_off, p->is_array);
        emit("    movq %s, %d(%%rbp)\n", pregs[pi], local_off);
    }

    gen_stmt(fn->fn_body);

    /* implicit return 0 */
    emit("    xorq %%rax, %%rax\n");
    emit("    movq %%rbp, %%rsp\n");
    emit("    popq %%rbp\n");
    emit("    retq\n");
    emit("    .size %s, .-%s\n\n", fn->fn_name, fn->fn_name);
}

/* ─── top-level driver ───────────────────────────────────── */

void codegen(Node *prog, FILE *out) {
    OUT = out;
    emit("    .section .note.GNU-stack,\"\",@progbits\n");

    /* global variables */
    for (NodeList *d = prog->stmts; d; d = d->next) {
        if (d->node->kind != ND_VARDECL) continue;
        Node *vd = d->node;
        GSym *g = calloc(1, sizeof *g);
        g->name = vd->var_name; g->is_arr = vd->var_arr > 0;
        g->next = globals; globals = g;
        emit("    .globl %s\n", vd->var_name);
        if (vd->var_arr > 0) {
            emit("    .bss\n");
            emit("%s:\n    .zero %d\n\n", vd->var_name, vd->var_arr * 8);
        } else if (vd->var_init && vd->var_init->kind == ND_NUM) {
            emit("    .data\n");
            emit("%s:\n    .quad %ld\n\n", vd->var_name, vd->var_init->num);
        } else {
            emit("    .comm %s,8,8\n", vd->var_name);
        }
    }

    /* functions */
    emit("\n    .text\n\n");
    for (NodeList *d = prog->stmts; d; d = d->next) {
        if (d->node->kind == ND_FUNC) gen_func(d->node);
    }

    /* string literals */
    if (strings) {
        emit("    .section .rodata\n");
        for (Str *s = strings; s; s = s->next) {
            emit(".Ls%d:\n    .string \"", s->id);
            for (char *p = s->val; *p; p++) {
                if (*p == '\n') emit("\\n");
                else if (*p == '\t') emit("\\t");
                else if (*p == '"')  emit("\\\"");
                else if (*p == '\\') emit("\\\\");
                else emit("%c", *p);
            }
            emit("\"\n");
        }
    }
}
