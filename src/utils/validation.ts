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

// We can export the inferred TypeScript types for these schemas too
export type SignUpInput = z.infer<typeof signUpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type PublishFormInput = z.infer<typeof publishFormSchema>;
