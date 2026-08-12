import {
  buildModuleBaseMap,
  parseAddress,
  parseMachineFormat,
} from '../src/analysis/machine-format';

describe('machine format address parsing', () => {
  it('parses bare digit-only addresses as hexadecimal', () => {
    expect(parseAddress('0000000012345678')).toBe(0x12345678);

    const dump = parseMachineFormat([
      'Module|foo.dll||||0000000012345678|000000001234ffff|1',
      '0|0|foo.dll|func|source.cc|42|0000000000000010',
    ].join('\n'));

    expect(dump.modules[0].baseAddress).toBe(0x12345678);
    expect(dump.frames[0]).toMatchObject({
      threadIndex: 0,
      frameIndex: 0,
      sourceLine: 42,
      moduleOffset: 0x10,
    });
  });

  it('keeps decimal thread and source-line fields decimal', () => {
    const dump = parseMachineFormat(
      'Module|foo.dll||||10|20|1\n10|11|foo.dll|func|source.cc|12|10',
    );

    expect(dump.modules[0].baseAddress).toBe(0x10);
    expect(dump.frames[0].threadIndex).toBe(10);
    expect(dump.frames[0].frameIndex).toBe(11);
    expect(dump.frames[0].sourceLine).toBe(12);
  });

  it('rejects addresses outside the safe integer range', () => {
    const dump = parseMachineFormat([
      'Module|unsafe.dll||||0x20000000000000|0x20000000000010|0',
      '0|0|unsafe.dll||source.cc|1|0x20000000000000',
      'Module|safe.dll||||0x1000|0x2000|0',
    ].join('\n'));

    expect(dump.modules.map(module => module.name)).toEqual(['safe.dll']);
    expect(dump.frames).toHaveLength(0);
    expect(buildModuleBaseMap(dump.modules).get('safe.dll')).toBe(0x1000);
  });
});
