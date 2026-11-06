import json
import os
import sqlite3
import tempfile
import unittest


class RelayStore(unittest.TestCase):
    def test_snapshot_is_read_only_owner_scoped_and_reads_all_chats(self):
        from dispatcher.relay_store import snapshot
        with tempfile.TemporaryDirectory() as root:
            app = sqlite3.connect(os.path.join(root, 'app.db'))
            app.executescript('CREATE TABLE user(id TEXT,email TEXT); '
                              'CREATE TABLE teams_accounts(slot INTEGER,owner_id TEXT,stopped INTEGER); '
                              "INSERT INTO user VALUES ('mine','me@example.com'),('other','other@example.com'); "
                              "INSERT INTO teams_accounts VALUES (1,'mine',0),(2,'other',0),(3,'mine',1);")
            app.close()
            os.mkdir(os.path.join(root, '1'))
            path = os.path.join(root, '1', 'messages.db')
            slot = sqlite3.connect(path)
            slot.executescript('CREATE TABLE state(k TEXT,v TEXT); CREATE TABLE chat_messages '
                               '(chat TEXT,idx INTEGER,mid TEXT,author TEXT,text TEXT,mine INTEGER,extra TEXT);')
            slot.executemany('INSERT INTO state VALUES (?,?)', [
                ('me', json.dumps({'email': 'Antonio@msccruises.com'})), ('last_scan_ts', '1793833200'),
                ('health', json.dumps({'teams': 'ok'}))])
            slot.execute('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?)',
                         ('After five old pinned chats', 0, '1793830000000', 'Bob', 'Fresh message', 0, '{}'))
            slot.commit()
            before = slot.total_changes
            slot.close()
            found = snapshot(root, 'me@example.com', 1793830000000)
            self.assertEqual(len(found['accounts']), 1)
            account = found['accounts'][0]
            self.assertEqual((account['slot'], account['email']), (1, 'antonio@msccruises.com'))
            self.assertEqual(account['messages'][0]['text'], 'Fresh message')
            with sqlite3.connect(path) as check:
                self.assertEqual(check.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='commands'").fetchone()[0], 0)
            check.close()

    def test_missing_database_is_not_created(self):
        from dispatcher.relay_store import snapshot
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(sqlite3.OperationalError):
                snapshot(root, 'me@example.com', 1793830000000)
            self.assertEqual(os.listdir(root), [])


if __name__ == '__main__':
    unittest.main()
