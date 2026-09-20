// Why a companion run failed, from the messages the virtual phone recorded.
//
// The census previously marked these cases companion-error-observed and left the
// reason blank, so every one of them looked alike and the corpus could not say
// whether hosting a relay would help. Each class below is a different decision:
// a configuration contract to implement, an API to add, a guest bug to report,
// or a network path that genuinely needs a service.

/** Ordered: the first pattern that matches a message decides the class. */
const CLASSES = [
  {
    id: 'network-refused',
    // The only class a relay could address.
    test: /CORS|Failed to fetch|NetworkError|net::|fetch failed|network request failed/i,
    summary: 'The browser refused the request to a third-party host.',
  },
  {
    id: 'network-unsupported',
    test: /Synchronous XMLHttpRequest|credentialed|upload progress/i,
    summary: 'The script used a networking feature the sandbox does not provide.',
  },
  {
    id: 'configuration-empty-response',
    // Cancelling configuration returns an empty string, which scripts JSON.parse.
    test: /Unexpected end of JSON input/i,
    summary: 'The script parsed the empty string returned by a cancelled configuration.',
  },
  {
    id: 'configuration-unsupported-url',
    test: /Configuration requires/i,
    summary: 'The script opened a configuration URL the sandbox does not accept.',
  },
  {
    id: 'appmessage-rejected',
    test: /AppMessage/i,
    summary: 'The script sent an AppMessage value the protocol does not carry.',
  },
  {
    id: 'missing-api',
    test: /not a function|is not defined|undefined is not/i,
    summary: 'The script called a PebbleKit JS API the sandbox does not implement.',
  },
  {
    id: 'script-error',
    test: /cannot read property|is not an object|TypeError|ReferenceError/i,
    summary: 'The script threw on its own data.',
  },
  {
    id: 'budget-exceeded',
    test: /interrupted|out of memory|limit exceeded/i,
    summary: 'The script exceeded an execution budget.',
  },
];

/**
 * Classifies one companion failure.
 * Returns the class of the first message that matches anything, so an earlier
 * incidental warning cannot mask the failure that followed it.
 */
export function classifyPhoneFailure(messages = []) {
  const list = (Array.isArray(messages) ? messages : [messages]).map((m) => String(m ?? ''));
  // Classes are consulted in priority order across every message, not message by
  // message: a run that threw on its own data and then hit a refused request is
  // reported as the refusal, which is the part that changes what would fix it.
  for (const entry of CLASSES) {
    const message = list.find((value) => entry.test.test(value));
    if (message !== undefined)
      return {
        failureClass: entry.id,
        summary: entry.summary,
        reason: message.split('\n')[0].slice(0, 200),
      };
  }
  return {
    failureClass: list.length ? 'unclassified' : 'no-message',
    summary: list.length
      ? 'The phone recorded an error that matches no known class.'
      : 'The phone failed with no recorded message.',
    reason: (list[0] ?? '').split('\n')[0].slice(0, 200),
  };
}

/** Counts each class across a set of classified failures, most common first. */
export function summariseFailureClasses(classified) {
  const counts = new Map();
  for (const { failureClass } of classified)
    counts.set(failureClass, (counts.get(failureClass) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([failureClass, cases]) => ({ failureClass, cases }));
}
