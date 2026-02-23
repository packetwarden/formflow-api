import { z } from 'zod';

export const signUpSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters long'),
    full_name: z.string().min(2, 'Name must be at least 2 characters long').optional(),
});

export const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
});

export const workspaceParamSchema = z.object({
    workspaceId: z.string().uuid('workspaceId must be a valid UUID'),
});

export const formParamSchema = z.object({
    formId: z.string().uuid('formId must be a valid UUID'),
});

export const buildParamSchema = workspaceParamSchema.merge(formParamSchema);
export const runnerFormParamSchema = formParamSchema;

export const runnerSubmitBodySchema = z.object({
    data: z.record(z.unknown()),
    started_at: z
        .string()
        .datetime({ offset: true, message: 'started_at must be a valid ISO datetime string with offset' })
        .optional(),
}).strict();

export const runnerIdempotencyHeaderSchema = z.object({
    'idempotency-key': z.string().uuid('Idempotency-Key must be a valid UUID'),
}).strict();

export const draftSchemaShape = z.object({
    layout: z.unknown(),
    theme: z.record(z.unknown()),
    steps: z.array(z.unknown()),
    logic: z.array(z.unknown()),
    settings: z.record(z.unknown()),
}).passthrough();

export const updateDraftSchema = z.object({
    schema: draftSchemaShape,
    version: z.number().int().min(1, 'version must be an integer >= 1'),
});

export const publishFormSchema = z.object({
    description: z.string().trim().max(500, 'description must be at most 500 characters').optional(),
});

const formTitleSchema = z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(200, 'title must be at most 200 characters');

const nullableClearableStringSchema = z
    .union([z.string(), z.null()])
    .transform((value) => {
        if (value === null) return null;
        const trimmed = value.trim();
        return trimmed.length === 0 ? null : trimmed;
    });

const nullablePositiveIntegerSchema = z.union([
    z.number().int().positive('max_submissions must be greater than 0'),
    z.null(),
]);

export const createFormSchema = z
    .object({
        title: formTitleSchema,
        description: nullableClearableStringSchema.optional(),
        schema: draftSchemaShape.optional(),
        max_submissions: nullablePositiveIntegerSchema.optional(),
        accept_submissions: z.boolean().optional(),
        success_message: nullableClearableStringSchema.optional(),
        redirect_url: nullableClearableStringSchema.optional(),
    })
    .strict();

export const updateFormMetaSchema = z
    .object({
        version: z.number().int().min(1, 'version must be an integer >= 1'),
        title: formTitleSchema.optional(),
        description: nullableClearableStringSchema.optional(),
        max_submissions: nullablePositiveIntegerSchema.optional(),
        accept_submissions: z.boolean().optional(),
        success_message: nullableClearableStringSchema.optional(),
        redirect_url: nullableClearableStringSchema.optional(),
    })
    .strict()
    .refine(
        (value) =>
            value.title !== undefined ||
            value.description !== undefined ||
            value.max_submissions !== undefined ||
            value.accept_submissions !== undefined ||
            value.success_message !== undefined ||
            value.redirect_url !== undefined,
        {
            message: 'At least one editable field must be provided',
        }
    );

// We can export the inferred TypeScript types for these schemas too
export type SignUpInput = z.infer<typeof signUpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type PublishFormInput = z.infer<typeof publishFormSchema>;
export type CreateFormInput = z.infer<typeof createFormSchema>;
export type UpdateFormMetaInput = z.infer<typeof updateFormMetaSchema>;
export type RunnerSubmitBodyInput = z.infer<typeof runnerSubmitBodySchema>;
export type RunnerIdempotencyHeaderInput = z.infer<typeof runnerIdempotencyHeaderSchema>;
