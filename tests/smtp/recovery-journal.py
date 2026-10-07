"""Synthetic offline replay fault fixture. Never prints the event payload."""
import json
import sqlite3
import sys
import hashlib

event = json.load(sys.stdin)
with sqlite3.connect('/spool/evidence/events.sqlite3', timeout=10) as connection:
    event_id = event['payload']['eventId']
    expected = (event_id, 'event', json.dumps(event['payload']), event['created'])
    old_id=hashlib.sha256(('expired:'+event_id).encode()).hexdigest()
    old_payload={**event['payload'],'eventId':old_id}
    old=(old_id,'event',json.dumps(old_payload),event['created']-31*86400)
    if sys.argv[1] == 'inject':
        connection.execute('INSERT INTO events VALUES (?,?,?,?)', expected)
        connection.execute('INSERT INTO seen VALUES (?,?)', (event_id, event['created']))
        connection.execute('INSERT INTO events VALUES (?,?,?,?)',old)
        connection.execute('INSERT INTO seen VALUES (?,?)',(old_id,old[3]))
        assert connection.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone() == expected
        print('Offline synthetic pending MTA observation injected before backup')
    elif sys.argv[1] == 'verify':
        assert connection.execute('SELECT * FROM restore_quarantine WHERE id=?', (event_id,)).fetchone() == expected
        assert connection.execute('SELECT count(*) FROM events WHERE id=?', (event_id,)).fetchone()[0] == 0
        assert connection.execute('SELECT created FROM seen WHERE id=?', (event_id,)).fetchone()[0] == event['created']
        for table in ['events','restore_quarantine','seen']:
            assert connection.execute('SELECT count(*) FROM '+table+' WHERE id=?',(old_id,)).fetchone()[0]==0
        print('Restored journal preserves quarantined evidence and seen marker without automatic replay')
    else:
        raise ValueError('synthetic_journal_phase_invalid')
