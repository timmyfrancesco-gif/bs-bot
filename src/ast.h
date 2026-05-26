#pragma once

typedef enum {
    ND_PROGRAM,
    ND_FUNC,    ND_VARDECL,
    ND_BLOCK,
    ND_IF,      ND_WHILE,   ND_FOR,
    ND_RETURN,  ND_BREAK,   ND_CONTINUE,
    ND_EXPR_STMT,
    ND_ASSIGN,  ND_BINOP,   ND_UNOP,
    ND_CALL,    ND_INDEX,
    ND_IDENT,   ND_NUM,     ND_STR,
    ND_INC,     ND_DEC,
} NodeKind;

typedef struct Node     Node;
typedef struct NodeList NodeList;
typedef struct Param    Param;

struct NodeList { Node *node; NodeList *next; };

struct Param {
    char  *name;
    int    is_array;
    Param *next;
};

struct Node {
    NodeKind kind;
    int      line;

    /* ND_FUNC */
    char    *fn_name;
    Param   *fn_params;
    Node    *fn_body;

    /* ND_VARDECL */
    char    *var_name;
    int      var_arr;   /* array size; 0 = scalar */
    Node    *var_init;

    /* ND_BLOCK / ND_PROGRAM: list of stmts/decls */
    NodeList *stmts;

    /* ND_IF */
    Node *cond, *then, *alt;

    /* ND_WHILE / ND_FOR */
    Node *init, *step, *body;

    /* ND_RETURN / ND_EXPR_STMT / ND_UNOP */
    Node *expr;

    /* ND_BINOP / ND_ASSIGN */
    Node *lhs, *rhs;
    char  op[4];

    /* ND_CALL */
    char     *call_name;
    NodeList *call_args;

    /* ND_INDEX */
    Node *arr, *idx;

    /* ND_IDENT */
    char *ident;

    /* ND_NUM */
    long num;

    /* ND_STR */
    char *str;

    /* ND_INC / ND_DEC */
    Node *operand;
    int   post;   /* 1=postfix, 0=prefix */
};
