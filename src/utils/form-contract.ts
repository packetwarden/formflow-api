import type { ValidationIssue } from '../types'

type Primitive = string | number | boolean

type SupportedFieldType =
    | 'text'
    | 'textarea'
    | 'email'
    | 'number'
    | 'tel'
    | 'url'
    | 'date'
    | 'datetime'
    | 'time'
    | 'radio'
    | 'select'
    | 'multiselect'
    | 'checkbox'
    | 'boolean'
    | 'rating'

type SupportedOperator =
    | 'eq'
    | 'neq'
    | 'in'
    | 'not_in'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'not_contains'
    | 'exists'
    | 'not_exists'

type VisibilityAction = 'show' | 'hide'

type NormalizedFieldDefinition = {
    id: string
    type: SupportedFieldType
    defaultVisible: boolean
    required: boolean
    min: number | undefined
    max: number | undefined
    minLength: number | undefined
    maxLength: number | undefined
    pattern: RegExp | undefined
    options: Primitive[] | undefined
}

type NormalizedCondition = {
    fieldId: string
    operator: SupportedOperator
    value: unknown
}

type NormalizedAction = {
    type: VisibilityAction
    targetFieldId: string
}

type NormalizedRule = {
    mode: 'all' | 'any'
    conditions: NormalizedCondition[]
    actions: NormalizedAction[]
}

export type NormalizedContract = {
    fields: Map<string, NormalizedFieldDefinition>
    rules: NormalizedRule[]
}

type ParsePublishedContractSuccess = {
    ok: true
    contract: NormalizedContract
}

type ParsePublishedContractFailure = {
    ok: false
    issues: string[]
}

type SanitizeAndValidateDataSuccess = {
    ok: true
    sanitizedData: Record<string, unknown>
}

type SanitizeAndValidateDataFailure = {
    ok: false
    payload: {
        error: 'Field validation failed'
        code: 'FIELD_VALIDATION_FAILED'
        issues: ValidationIssue[]
        unknown_fields?: string[]
    }
}

const SUPPORTED_FIELD_TYPES = new Set<SupportedFieldType>([
    'text',
    'textarea',
    'email',
    'number',
    'tel',
    'url',
    'date',
    'datetime',
    'time',
    'radio',
    'select',
    'multiselect',
    'checkbox',
    'boolean',
    'rating',
])

const SUPPORTED_VALIDATION_KEYS = new Set([
    'required',
    'min',
    'max',
    'minLength',
    'maxLength',
    'pattern',
    'options',
])

const SUPPORTED_OPERATORS = new Set<SupportedOperator>([
    'eq',
    'neq',
    'in',
    'not_in',
    'gt',
    'gte',
    'lt',
    'lte',
    'contains',
    'not_contains',
    'exists',
    'not_exists',
])

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isPrimitiveValue = (value: unknown): value is Primitive => {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

const readFirstDefined = (source: Record<string, unknown>, aliases: string[]) => {
    for (const alias of aliases) {
        if (source[alias] !== undefined) {
            return source[alias]
        }
    }
    return undefined
}

const readAliasString = (source: Record<string, unknown>, aliases: string[]) => {
    const value = readFirstDefined(source, aliases)
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const normalizeOperator = (rawOperator: string): SupportedOperator | null => {
    const operator = rawOperator.toLowerCase().trim()
    const aliasMap: Record<string, SupportedOperator> = {
        '=': 'eq',
        '==': 'eq',
        eq: 'eq',
        '!=': 'neq',
        '<>': 'neq',
        neq: 'neq',
        not_eq: 'neq',
        gt: 'gt',
        '>': 'gt',
        gte: 'gte',
        '>=': 'gte',
        lt: 'lt',
        '<': 'lt',
        lte: 'lte',
        '<=': 'lte',
        in: 'in',
        nin: 'not_in',
        not_in: 'not_in',
        contains: 'contains',
        includes: 'contains',
        not_contains: 'not_contains',
        not_includes: 'not_contains',
        exists: 'exists',
        not_exists: 'not_exists',
    }

    return aliasMap[operator] ?? null
}

const normalizeAction = (rawType: string, actionNode: Record<string, unknown>): VisibilityAction | null => {
    const type = rawType.toLowerCase().trim()

    if (type === 'show' || type === 'show_field' || type === 'showfield') return 'show'
    if (type === 'hide' || type === 'hide_field' || type === 'hidefield') return 'hide'

    if (type === 'set_visibility' || type === 'setvisibility') {
        const visible = readFirstDefined(actionNode, ['visible', 'isVisible', 'value'])
        if (typeof visible !== 'boolean') return null
        return visible ? 'show' : 'hide'
    }

    return null
}

const getOptionPrimitive = (option: unknown): Primitive | null => {
    if (typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean') {
        return option
    }

    if (!isRecord(option)) return null
    const value = readFirstDefined(option, ['value', 'id', 'key', 'name'])
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    return null
}

const parseSupportedField = (
    rawField: unknown,
    fieldRegistry: Map<string, NormalizedFieldDefinition>,
    issues: string[]
) => {
    if (!isRecord(rawField)) {
        issues.push('Field entry must be an object')
        return
    }

    const fieldId = readAliasString(rawField, ['id', 'field_id', 'fieldId', 'key', 'name'])
    if (!fieldId) {
        issues.push('Each field must include a non-empty id')
        return
    }

    if (fieldRegistry.has(fieldId)) {
        issues.push(`Duplicate field id "${fieldId}"`)
        return
    }

    const rawType = readAliasString(rawField, ['type', 'field_type', 'fieldType'])
    if (!rawType) {
        issues.push(`Field "${fieldId}" must include a non-empty type`)
        return
    }

    const type = rawType.toLowerCase() as SupportedFieldType
    if (!SUPPORTED_FIELD_TYPES.has(type)) {
        issues.push(`Field "${fieldId}" has unsupported type "${rawType}"`)
        return
    }

    const validationBuckets: Record<string, unknown>[] = []

    if (rawField.rules !== undefined) {
        if (!isRecord(rawField.rules)) {
            issues.push(`Field "${fieldId}" has invalid rules object`)
            return
        }
        validationBuckets.push(rawField.rules)
    }

    if (rawField.validation !== undefined) {
        if (!isRecord(rawField.validation)) {
            issues.push(`Field "${fieldId}" has invalid validation object`)
            return
        }
        validationBuckets.push(rawField.validation)
    }

    for (const validationBucket of validationBuckets) {
        for (const validationKey of Object.keys(validationBucket)) {
            if (!SUPPORTED_VALIDATION_KEYS.has(validationKey)) {
                issues.push(`Field "${fieldId}" uses unsupported validation key "${validationKey}"`)
                return
            }
        }
    }

    const mergedValidation = Object.assign({}, ...validationBuckets)
    const requiredValue = readFirstDefined({ ...rawField, ...mergedValidation }, ['required'])
    const minValue = readFirstDefined({ ...rawField, ...mergedValidation }, ['min'])
    const maxValue = readFirstDefined({ ...rawField, ...mergedValidation }, ['max'])
    const minLengthValue = readFirstDefined({ ...rawField, ...mergedValidation }, ['minLength'])
    const maxLengthValue = readFirstDefined({ ...rawField, ...mergedValidation }, ['maxLength'])
    const patternValue = readFirstDefined({ ...rawField, ...mergedValidation }, ['pattern'])
    const optionsValue = readFirstDefined({ ...rawField, ...mergedValidation }, ['options'])
    const hiddenValue = readFirstDefined(rawField, ['hidden', 'isHidden'])

    if (requiredValue !== undefined && typeof requiredValue !== 'boolean') {
        issues.push(`Field "${fieldId}" has non-boolean "required"`)
        return
    }

    const numericKeys = [
        { key: 'min', value: minValue },
        { key: 'max', value: maxValue },
        { key: 'minLength', value: minLengthValue },
        { key: 'maxLength', value: maxLengthValue },
    ]

    for (const entry of numericKeys) {
        if (entry.value !== undefined && (typeof entry.value !== 'number' || !Number.isFinite(entry.value))) {
            issues.push(`Field "${fieldId}" has invalid numeric "${entry.key}"`)
            return
        }
    }

    if (hiddenValue !== undefined && typeof hiddenValue !== 'boolean') {
        issues.push(`Field "${fieldId}" has non-boolean "hidden"`)
        return
    }

    let compiledPattern: RegExp | undefined
    if (patternValue !== undefined) {
        if (typeof patternValue !== 'string') {
            issues.push(`Field "${fieldId}" has non-string "pattern"`)
            return
        }
        try {
            compiledPattern = new RegExp(patternValue)
        } catch {
            issues.push(`Field "${fieldId}" has invalid regex pattern`)
            return
        }
    }

    let normalizedOptions: Primitive[] | undefined
    if (optionsValue !== undefined) {
        if (!Array.isArray(optionsValue)) {
            issues.push(`Field "${fieldId}" has non-array "options"`)
            return
        }

        normalizedOptions = []
        for (const option of optionsValue) {
            const primitive = getOptionPrimitive(option)
            if (primitive === null) {
                issues.push(`Field "${fieldId}" contains unsupported option shape`)
                return
            }
            normalizedOptions.push(primitive)
        }
    }

    if ((type === 'radio' || type === 'select' || type === 'multiselect') && (!normalizedOptions || normalizedOptions.length === 0)) {
        issues.push(`Field "${fieldId}" type "${type}" requires non-empty options`)
        return
    }

    fieldRegistry.set(fieldId, {
        id: fieldId,
        type,
        defaultVisible: hiddenValue ? false : true,
        required: requiredValue ?? false,
        min: minValue as number | undefined,
        max: maxValue as number | undefined,
        minLength: minLengthValue as number | undefined,
        maxLength: maxLengthValue as number | undefined,
        pattern: compiledPattern,
        options: normalizedOptions,
    })
}

const parseConditionsGroup = (
    rawConditions: unknown,
    fieldRegistry: Map<string, NormalizedFieldDefinition>,
    issues: string[]
) => {
    const parseConditionObject = (rawCondition: unknown) => {
        if (!isRecord(rawCondition)) {
            issues.push('Each logic condition must be an object')
            return null
        }

        const sourceFieldId = readAliasString(rawCondition, [
            'field_id',
            'fieldId',
            'field',
            'source_field_id',
            'sourceFieldId',
            'id',
            'key',
            'name',
        ])

        if (!sourceFieldId || !fieldRegistry.has(sourceFieldId)) {
            issues.push('Logic condition references an unknown source field')
            return null
        }

        const rawOperator = readAliasString(rawCondition, ['operator', 'op'])
        let operator: SupportedOperator | null = null

        if (rawOperator) {
            operator = normalizeOperator(rawOperator)
        } else if (typeof rawCondition.exists === 'boolean') {
            operator = rawCondition.exists ? 'exists' : 'not_exists'
        } else {
            operator = 'eq'
        }

        if (!operator || !SUPPORTED_OPERATORS.has(operator)) {
            issues.push('Logic condition uses unsupported operator')
            return null
        }

        const value = readFirstDefined(rawCondition, ['value', 'equals', 'expected', 'target'])
        if (operator !== 'exists' && operator !== 'not_exists' && value === undefined) {
            issues.push('Logic condition must include a value for the selected operator')
            return null
        }

        if (operator === 'in' || operator === 'not_in') {
            if (!Array.isArray(value)) {
                issues.push('Logic condition uses in/not_in with a non-array value')
                return null
            }

            if (value.some((entry) => !isPrimitiveValue(entry))) {
                issues.push('Logic condition uses in/not_in with non-primitive array values')
                return null
            }
        }

        if ((operator === 'contains' || operator === 'not_contains') && !isPrimitiveValue(value)) {
            issues.push('Logic condition uses contains/not_contains with a non-primitive value')
            return null
        }

        if ((operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte')
            && typeof value !== 'number'
            && typeof value !== 'string') {
            issues.push('Logic condition uses ordered comparison with a non-scalar value')
            return null
        }

        return {
            fieldId: sourceFieldId,
            operator,
            value,
        } satisfies NormalizedCondition
    }

    if (Array.isArray(rawConditions)) {
        const parsedConditions = rawConditions.map(parseConditionObject)
        if (parsedConditions.some((entry) => entry === null)) return null
        return { mode: 'all' as const, conditions: parsedConditions as NormalizedCondition[] }
    }

    if (!isRecord(rawConditions)) {
        issues.push('Logic condition block must be an object or array')
        return null
    }

    const hasAll = rawConditions.all !== undefined
    const hasAny = rawConditions.any !== undefined

    if (hasAll || hasAny) {
        if (hasAll && hasAny) {
            issues.push('Logic condition block cannot define both "all" and "any"')
            return null
        }

        const rawList = hasAll ? rawConditions.all : rawConditions.any
        if (!Array.isArray(rawList)) {
            issues.push('Logic condition list must be an array')
            return null
        }

        const parsedConditions = rawList.map(parseConditionObject)
        if (parsedConditions.some((entry) => entry === null)) return null
        return {
            mode: hasAll ? 'all' as const : 'any' as const,
            conditions: parsedConditions as NormalizedCondition[],
        }
    }

    const singleCondition = parseConditionObject(rawConditions)
    if (!singleCondition) return null
    return {
        mode: 'all' as const,
        conditions: [singleCondition],
    }
}

const parseActionsBlock = (
    rawActions: unknown,
    fieldRegistry: Map<string, NormalizedFieldDefinition>,
    issues: string[]
) => {
    const parseActionObject = (rawAction: unknown) => {
        if (!isRecord(rawAction)) {
            issues.push('Each logic action must be an object')
            return null
        }

        const actionTypeRaw = readAliasString(rawAction, ['type', 'action'])
        if (!actionTypeRaw) {
            issues.push('Logic action must include a type/action field')
            return null
        }

        const actionType = normalizeAction(actionTypeRaw, rawAction)
        if (!actionType) {
            issues.push(`Logic action type "${actionTypeRaw}" is unsupported`)
            return null
        }

        const targetFieldId = readAliasString(rawAction, [
            'field_id',
            'fieldId',
            'target',
            'target_field_id',
            'targetFieldId',
            'id',
            'key',
            'name',
        ])

        if (!targetFieldId || !fieldRegistry.has(targetFieldId)) {
            issues.push('Logic action references an unknown target field')
            return null
        }

        return {
            type: actionType,
            targetFieldId,
        } satisfies NormalizedAction
    }

    if (Array.isArray(rawActions)) {
        const parsedActions = rawActions.map(parseActionObject)
        if (parsedActions.some((entry) => entry === null)) return null
        return parsedActions as NormalizedAction[]
    }

    if (!isRecord(rawActions)) {
        issues.push('Logic action block must be an object or array')
        return null
    }

    const singleAction = parseActionObject(rawActions)
    return singleAction ? [singleAction] : null
}

const isPresent = (value: unknown) => {
    if (value === null || value === undefined) return false
    if (typeof value === 'string' && value.trim().length === 0) return false
    if (Array.isArray(value) && value.length === 0) return false
    return true
}

const areEqual = (left: unknown, right: unknown) => {
    return JSON.stringify(left) === JSON.stringify(right)
}

const compareOrdered = (left: unknown, right: unknown) => {
    const leftNumber = typeof left === 'number' ? left : Number(left)
    const rightNumber = typeof right === 'number' ? right : Number(right)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        if (leftNumber < rightNumber) return -1
        if (leftNumber > rightNumber) return 1
        return 0
    }

    if (typeof left === 'string' && typeof right === 'string') {
        const leftDate = Date.parse(left)
        const rightDate = Date.parse(right)
        if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) {
            if (leftDate < rightDate) return -1
            if (leftDate > rightDate) return 1
            return 0
        }
    }

    return null
}

const evaluateCondition = (condition: NormalizedCondition, submittedData: Record<string, unknown>) => {
    const actualValue = submittedData[condition.fieldId]

    switch (condition.operator) {
        case 'eq':
            return areEqual(actualValue, condition.value)
        case 'neq':
            return !areEqual(actualValue, condition.value)
        case 'in':
            return Array.isArray(condition.value) && condition.value.some((entry) => areEqual(actualValue, entry))
        case 'not_in':
            return Array.isArray(condition.value) && !condition.value.some((entry) => areEqual(actualValue, entry))
        case 'gt': {
            const comparison = compareOrdered(actualValue, condition.value)
            return comparison !== null && comparison > 0
        }
        case 'gte': {
            const comparison = compareOrdered(actualValue, condition.value)
            return comparison !== null && comparison >= 0
        }
        case 'lt': {
            const comparison = compareOrdered(actualValue, condition.value)
            return comparison !== null && comparison < 0
        }
        case 'lte': {
            const comparison = compareOrdered(actualValue, condition.value)
            return comparison !== null && comparison <= 0
        }
        case 'contains':
            if (typeof actualValue === 'string' && typeof condition.value === 'string') {
                return actualValue.includes(condition.value)
            }
            if (Array.isArray(actualValue)) {
                return actualValue.some((entry) => areEqual(entry, condition.value))
            }
            return false
        case 'not_contains':
            if (typeof actualValue === 'string' && typeof condition.value === 'string') {
                return !actualValue.includes(condition.value)
            }
            if (Array.isArray(actualValue)) {
                return !actualValue.some((entry) => areEqual(entry, condition.value))
            }
            return true
        case 'exists':
            return isPresent(actualValue)
        case 'not_exists':
            return !isPresent(actualValue)
        default:
            return false
    }
}

const evaluateVisibility = (
    contract: NormalizedContract,
    submittedData: Record<string, unknown>
) => {
    const visibility = new Map<string, boolean>()
    for (const field of contract.fields.values()) {
        visibility.set(field.id, field.defaultVisible)
    }

    for (const rule of contract.rules) {
        const matched =
            rule.mode === 'all'
                ? rule.conditions.every((condition) => evaluateCondition(condition, submittedData))
                : rule.conditions.some((condition) => evaluateCondition(condition, submittedData))

        if (!matched) continue

        for (const action of rule.actions) {
            visibility.set(action.targetFieldId, action.type === 'show')
        }
    }

    return visibility
}

const optionSetFromField = (field: NormalizedFieldDefinition) => {
    if (!field.options) return null
    return new Set(field.options.map((entry) => `${typeof entry}:${String(entry)}`))
}

const validateFieldValue = (field: NormalizedFieldDefinition, value: unknown): string | null => {
    switch (field.type) {
        case 'text':
        case 'textarea':
        case 'tel':
        case 'date':
        case 'datetime':
        case 'time':
        case 'email':
        case 'url': {
            if (typeof value !== 'string') return 'must be a string'

            if (field.type === 'email') {
                const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                if (!emailPattern.test(value)) return 'must be a valid email'
            }

            if (field.type === 'url') {
                try {
                    new URL(value)
                } catch {
                    return 'must be a valid URL'
                }
            }

            if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                return 'must be in YYYY-MM-DD format'
            }

            if (field.type === 'datetime' && Number.isNaN(Date.parse(value))) {
                return 'must be a valid ISO datetime string'
            }

            if (field.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) {
                return 'must be in HH:mm or HH:mm:ss format'
            }

            if (field.minLength !== undefined && value.length < field.minLength) {
                return `must have at least ${field.minLength} characters`
            }

            if (field.maxLength !== undefined && value.length > field.maxLength) {
                return `must have at most ${field.maxLength} characters`
            }

            if (field.pattern && !field.pattern.test(value)) {
                return 'does not match required pattern'
            }

            return null
        }
        case 'number':
        case 'rating': {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return 'must be a valid number'
            }

            if (field.type === 'rating' && !Number.isInteger(value)) {
                return 'must be an integer'
            }

            if (field.min !== undefined && value < field.min) {
                return `must be greater than or equal to ${field.min}`
            }

            if (field.max !== undefined && value > field.max) {
                return `must be less than or equal to ${field.max}`
            }

            return null
        }
        case 'checkbox':
        case 'boolean': {
            if (typeof value !== 'boolean') return 'must be a boolean'
            if (field.type === 'checkbox' && field.required && value !== true) {
                return 'must be checked'
            }
            return null
        }
        case 'radio':
        case 'select': {
            if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
                return 'must be a primitive value'
            }

            const options = optionSetFromField(field)
            if (!options) return 'requires configured options'
            const candidate = `${typeof value}:${String(value)}`
            if (!options.has(candidate)) return 'must match one of the allowed options'
            return null
        }
        case 'multiselect': {
            if (!Array.isArray(value)) return 'must be an array'

            const options = optionSetFromField(field)
            if (!options) return 'requires configured options'

            for (const item of value) {
                if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
                    return 'array values must be primitive'
                }
                const candidate = `${typeof item}:${String(item)}`
                if (!options.has(candidate)) return 'contains values outside allowed options'
            }

            if (field.min !== undefined && value.length < field.min) {
                return `must include at least ${field.min} option(s)`
            }

            if (field.max !== undefined && value.length > field.max) {
                return `must include at most ${field.max} option(s)`
            }

            return null
        }
        default:
            return 'has unsupported field type'
    }
}

export const parsePublishedContract = (publishedSchema: unknown): ParsePublishedContractSuccess | ParsePublishedContractFailure => {
    if (!isRecord(publishedSchema)) {
        return {
            ok: false,
            issues: ['published_schema must be a JSON object'],
        }
    }

    const fieldRegistry = new Map<string, NormalizedFieldDefinition>()
    const issues: string[] = []

    if (publishedSchema.fields !== undefined) {
        if (!Array.isArray(publishedSchema.fields)) {
            return { ok: false, issues: ['published_schema.fields must be an array'] }
        }
        for (const rawField of publishedSchema.fields) {
            parseSupportedField(rawField, fieldRegistry, issues)
            if (issues.length > 0) return { ok: false, issues }
        }
    }

    if (publishedSchema.steps !== undefined) {
        if (!Array.isArray(publishedSchema.steps)) {
            return { ok: false, issues: ['published_schema.steps must be an array'] }
        }

        for (const rawStep of publishedSchema.steps) {
            if (!isRecord(rawStep)) {
                return { ok: false, issues: ['Each step must be an object'] }
            }

            if (rawStep.fields === undefined) continue
            if (!Array.isArray(rawStep.fields)) {
                return { ok: false, issues: ['step.fields must be an array when present'] }
            }

            for (const rawField of rawStep.fields) {
                parseSupportedField(rawField, fieldRegistry, issues)
                if (issues.length > 0) return { ok: false, issues }
            }
        }
    }

    const rawLogic = publishedSchema.logic
    const logicEntries: unknown[] =
        rawLogic === undefined || rawLogic === null
            ? []
            : Array.isArray(rawLogic)
                ? rawLogic
                : []

    if (rawLogic !== undefined && rawLogic !== null && !Array.isArray(rawLogic)) {
        return { ok: false, issues: ['published_schema.logic must be an array'] }
    }

    const normalizedRules: NormalizedRule[] = []
    for (const rawRule of logicEntries) {
        if (!isRecord(rawRule)) {
            return { ok: false, issues: ['Each logic rule must be an object'] }
        }

        if (rawRule.enabled === false || rawRule.isActive === false) {
            continue
        }

        const rawConditions = readFirstDefined(rawRule, ['if', 'when', 'conditions'])
        const rawActions = readFirstDefined(rawRule, ['then', 'action', 'actions'])
        if (rawConditions === undefined || rawActions === undefined) {
            return {
                ok: false,
                issues: ['Each logic rule must define conditions and actions (if/when/conditions + then/action/actions)'],
            }
        }

        const parsedConditionsGroup = parseConditionsGroup(rawConditions, fieldRegistry, issues)
        if (!parsedConditionsGroup) return { ok: false, issues }

        const parsedActions = parseActionsBlock(rawActions, fieldRegistry, issues)
        if (!parsedActions) return { ok: false, issues }

        normalizedRules.push({
            mode: parsedConditionsGroup.mode,
            conditions: parsedConditionsGroup.conditions,
            actions: parsedActions,
        })
    }

    return {
        ok: true,
        contract: {
            fields: fieldRegistry,
            rules: normalizedRules,
        },
    }
}

export const sanitizeAndValidateData = (
    contract: NormalizedContract,
    inputData: Record<string, unknown>
): SanitizeAndValidateDataSuccess | SanitizeAndValidateDataFailure => {
    const visibility = evaluateVisibility(contract, inputData)
    const unknownFields: string[] = []
    const sanitizedData: Record<string, unknown> = {}
    const fieldErrors: ValidationIssue[] = []

    for (const [fieldId, submittedValue] of Object.entries(inputData)) {
        if (!contract.fields.has(fieldId)) {
            unknownFields.push(fieldId)
            continue
        }

        if (!visibility.get(fieldId)) {
            continue
        }

        sanitizedData[fieldId] = submittedValue
    }

    if (unknownFields.length > 0) {
        return {
            ok: false,
            payload: {
                error: 'Field validation failed',
                code: 'FIELD_VALIDATION_FAILED',
                unknown_fields: unknownFields,
                issues: unknownFields.map((fieldId) => ({
                    field_id: fieldId,
                    message: 'Field is not part of the published schema',
                })),
            },
        }
    }

    for (const field of contract.fields.values()) {
        if (!visibility.get(field.id)) continue

        const submittedValue = sanitizedData[field.id]
        const missing = !isPresent(submittedValue)

        if (missing) {
            if (field.required) {
                fieldErrors.push({
                    field_id: field.id,
                    message: 'Required field is missing',
                })
            }
            continue
        }

        const validationError = validateFieldValue(field, submittedValue)
        if (validationError) {
            fieldErrors.push({
                field_id: field.id,
                message: validationError,
            })
        }
    }

    if (fieldErrors.length > 0) {
        return {
            ok: false,
            payload: {
                error: 'Field validation failed',
                code: 'FIELD_VALIDATION_FAILED',
                issues: fieldErrors,
            },
        }
    }

    return {
        ok: true,
        sanitizedData,
    }
}
