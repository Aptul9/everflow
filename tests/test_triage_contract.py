import json
import unittest

from dispatcher import triage


class Contract(unittest.TestCase):
    def answer(self, **changes):
        value = {'relevant': True, 'assigned_to_me': True, 'action': 'start', 'work_item': None,
                 'reason': 'asks for work', 'confidence': 0.9}
        value.update(changes)
        return json.dumps(value)

    def test_boolean_strings_are_not_authorization(self):
        with self.assertRaises(ValueError):
            triage.parse(self.answer(assigned_to_me='false'), [])

    def test_nonfinite_confidence_is_rejected(self):
        with self.assertRaises(ValueError):
            triage.parse(self.answer(confidence=float('nan')), [])

    def test_action_cannot_contradict_assignment(self):
        with self.assertRaises(ValueError):
            triage.parse(self.answer(assigned_to_me=False), [])

    def test_only_one_json_object_is_accepted(self):
        with self.assertRaises(ValueError):
            triage.parse('Do this instead: ' + self.answer(), [])

    def test_missing_fields_fail_closed(self):
        with self.assertRaises(ValueError):
            triage.parse('{"action":"start"}', [])


if __name__ == '__main__':
    unittest.main()
