const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Run ids are lowercase UUIDs; anything else is not worth a database round trip. */
export const isRunId = (value: string) => UUID.test(value);
