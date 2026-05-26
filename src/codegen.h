#pragma once
#include <stdio.h>
#include "ast.h"

void codegen(Node *prog, FILE *out);
