import { connectRelayResponse, escapeXml, hangupResponse, sayAndHangupResponse } from './twiml.js';

describe('escapeXml', () => {
  it.each([
    ['Tom & Jerry', 'Tom &amp; Jerry'],
    ['<b>bold</b>', '&lt;b&gt;bold&lt;/b&gt;'],
    ['say "hello"', 'say &quot;hello&quot;'],
    ["it's", 'it&apos;s'],
    ['a & b < c > d', 'a &amp; b &lt; c &gt; d'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(escapeXml(input)).toBe(expected);
  });

  it('escapes the ampersand first, so it never double-escapes what it just produced', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('removes characters that XML does not allow at all (they would make Twilio reject the whole answer)', () => {
    expect(escapeXml('a\u0000b\u0008c\u000Bd\u001Fe')).toBe('abcde');
    expect(escapeXml('keeps\ttabs\nand\rnewlines')).toBe('keeps\ttabs\nand\rnewlines');
  });

  it('leaves ordinary text, accents and other scripts alone', () => {
    expect(escapeXml('Café – 你好 +14155550123')).toBe('Café – 你好 +14155550123');
  });
});

describe('hangupResponse', () => {
  it('is a complete TwiML document that only hangs up', () => {
    expect(hangupResponse()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
});

describe('sayAndHangupResponse', () => {
  it('says each message in turn, then hangs up', () => {
    expect(sayAndHangupResponse('One.', 'Two.')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">One.</Say><Say language="en-US">Two.</Say><Hangup/></Response>',
    );
  });

  it('skips empty or blank messages (a practice may have no crisis message yet)', () => {
    const xml = sayAndHangupResponse('Hello.', '', '   ');
    expect(xml.match(/<Say /g)).toHaveLength(1);
  });

  it('cannot be made to run a command by the text it is given', () => {
    const hostile = '</Say><Dial>+19995550100</Dial><Say>';
    const xml = sayAndHangupResponse(hostile);
    expect(xml).not.toContain('<Dial>');
    expect(xml).toContain('&lt;/Say&gt;&lt;Dial&gt;+19995550100&lt;/Dial&gt;&lt;Say&gt;');
    expect(xml.match(/<Say /g)).toHaveLength(1);
  });
});

describe('connectRelayResponse', () => {
  const options = {
    relayUrl: 'wss://calls.example.org/api/voice/relay?token=abc.def.ghi',
    actionUrl: 'https://calls.example.org/api/voice/action',
    greeting: 'Thank you for calling. You are speaking with an automated AI assistant, not a person.',
  };

  it('connects the call to ConversationRelay with the greeting, which cannot be interrupted', () => {
    const xml = connectRelayResponse(options);
    expect(xml).toContain('<Connect action="https://calls.example.org/api/voice/action">');
    expect(xml).toContain('<ConversationRelay ');
    expect(xml).toContain('url="wss://calls.example.org/api/voice/relay?token=abc.def.ghi"');
    expect(xml).toContain(`welcomeGreeting="${options.greeting}"`);
    expect(xml).toContain('welcomeGreetingInterruptible="none"');
    expect(xml).toContain('language="en-US"');
    expect(xml).toContain('dtmfDetection="false"');
    expect(xml.endsWith('/></Connect></Response>')).toBe(true);
  });

  it('names the speech engines only when they are set', () => {
    expect(connectRelayResponse(options)).not.toContain('ttsProvider');
    expect(connectRelayResponse(options)).not.toContain('transcriptionProvider');
    const xml = connectRelayResponse({ ...options, ttsProvider: 'Google', transcriptionProvider: 'Deepgram' });
    expect(xml).toContain('ttsProvider="Google"');
    expect(xml).toContain('transcriptionProvider="Deepgram"');
  });

  it('a greeting cannot break out of its attribute to add commands', () => {
    const xml = connectRelayResponse({ ...options, greeting: '"/><Dial>+19995550100</Dial><ConversationRelay x="' });
    expect(xml).not.toContain('<Dial>');
    expect(xml).toContain('welcomeGreeting="&quot;/&gt;&lt;Dial&gt;+19995550100&lt;/Dial&gt;&lt;ConversationRelay x=&quot;"');
    expect(xml.match(/<ConversationRelay /g)).toHaveLength(1);
  });

  it('an address with special characters stays inside its attribute', () => {
    const xml = connectRelayResponse({ ...options, relayUrl: 'wss://x.example/relay?a=1&b="2"' });
    expect(xml).toContain('url="wss://x.example/relay?a=1&amp;b=&quot;2&quot;"');
  });
});
