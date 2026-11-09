export function createRequestGeneration() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    current() { return generation; },
    isCurrent(value: number) { return value === generation; },
  };
}
