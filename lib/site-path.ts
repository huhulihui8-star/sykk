export function sitePath(value: string) { return (process.env.NEXT_PUBLIC_BASE_PATH ?? '') + value; }
