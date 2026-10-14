import type { PickTagSet } from './pick.js';

/** The shared decision tag sets: intent, importance, emphasis and
 *  whether the item corrects something earlier. Every question is a
 *  narrow yes/no one the decide interface already answers; a set's
 *  recorded value is the first of its questions answered at
 *  probability 0.5 or more — the questions are ordered so earlier
 *  keys take precedence, highest level first for importance — or
 *  'yes'/'no' for a single-question set, and unset when nothing
 *  reaches 0.5. Intent orders correction and decision ahead of
 *  instruction: a corrective direction like "don't use the old
 *  endpoint, use the new one" is both, and the correction is what
 *  lets it displace the earlier line it fixes. Supply as
 *  `PickOptions.tags`; source-kind extras (commit kinds, note kinds)
 *  live in their own packages and go in `tagsByKind`. */
export const DECISION_TAGS: readonly PickTagSet[] = [
  {
    key: 'intent',
    questions: [
      { key: 'correction', instructions: 'Does this item correct, retract or replace an earlier statement, decision or fact?',
        true: 'It corrects or replaces an earlier one.', false: 'It corrects nothing earlier.' },
      { key: 'decision', instructions: 'Does this item state that a choice was made or settled?',
        true: 'It states a decision.', false: 'It states no decision.' },
      { key: 'instruction', instructions: 'Does this item tell the reader to do or avoid something: an instruction, direction or request?',
        true: 'It instructs or directs.', false: 'It does not instruct or direct.' },
      { key: 'idea', instructions: 'Does this item raise an idea, suggestion or possibility without settling it?',
        true: 'It is an open idea or suggestion.', false: 'It is settled, or not an idea.' },
      { key: 'question', instructions: 'Does this item mainly ask a question?',
        true: 'It mainly asks.', false: 'It does not mainly ask.' },
      { key: 'fact', instructions: 'Does this item mainly state a fact, event or piece of information?',
        true: 'It mainly states a fact.', false: 'It does not mainly state a fact.' },
      { key: 'chat', instructions: 'Is this item ordinary conversation or process chatter with no instruction, decision, idea or fact of its own?',
        true: 'It is chatter.', false: 'It carries more than chatter.' },
    ],
  },
  {
    key: 'importance',
    questions: [
      { key: 'critical', instructions: 'Would losing this item break a hard rule, a settled decision or a fact the task cannot be done without?',
        true: 'Losing it would break the work.', false: 'The work survives without it.' },
      { key: 'important', instructions: 'Would losing this item noticeably weaken the answer or the work?',
        true: 'Losing it weakens the work.', false: 'Losing it changes little.' },
      { key: 'relevant', instructions: 'Does this item bear on the task without being needed for it?',
        true: 'It bears on the task.', false: 'It does not bear on the task.' },
      { key: 'passing', instructions: 'Is this item only mentioned in passing: background that happens to match?',
        true: 'It is only in passing.', false: 'It is more than passing.' },
    ],
  },
  {
    key: 'emphasis',
    questions: [
      { key: 'emphatic', instructions: 'Does the wording push hard: insistence, frustration, capitals or repeated stress?',
        true: 'It is emphatic or frustrated.', false: 'It is even-toned.' },
      { key: 'approving', instructions: 'Does this item express approval or endorsement?',
        true: 'It approves.', false: 'It does not approve.' },
      { key: 'neutral', instructions: 'Is the tone plain and unmarked?',
        true: 'It is plain.', false: 'It is marked.' },
    ],
  },
  {
    key: 'corrects',
    questions: [
      { key: 'yes', instructions: 'Does this item correct, retract or replace something stated earlier?',
        true: 'It corrects something earlier.', false: 'It corrects nothing earlier.' },
    ],
  },
];
