import unittest
from pathlib import Path
from research import memory_bounds, memory_fragment, BEGIN_MARKER, END_MARKER


class FragmentTests(unittest.TestCase):
    def test_wrapped_and_raw_fragments_reconstruct_original_source(self):
        source = (Path(__file__).resolve().parents[2] / 'crates/qemu-emery/src/lib.rs').read_text()
        start, end = memory_bounds(source)
        raw = source[start:end]
        self.assertEqual(memory_fragment(raw), raw)
        wrapped = 'impl PebbleBus {\n' + raw + '}\n'
        self.assertEqual(source[:start] + memory_fragment(wrapped) + source[end:], source)

    def test_boundaries_retain_helpers_in_followup_experiments(self):
        source = 'protected\n' + BEGIN_MARKER + 'fn helper() {}\n    fn read_byte() {}\n' + END_MARKER + 'protected'
        start, end = memory_bounds(source)
        self.assertEqual(source[start:end], 'fn helper() {}\n    fn read_byte() {}\n')


if __name__ == '__main__':
    unittest.main()
