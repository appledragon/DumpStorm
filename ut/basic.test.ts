describe('Basic Test', () => {
  test('Jest is working', () => {
    expect(1 + 1).toBe(2);
  });

  test('can mock functions', () => {
    const mockFn = jest.fn();
    mockFn('test');
    expect(mockFn).toHaveBeenCalledWith('test');
  });
});
