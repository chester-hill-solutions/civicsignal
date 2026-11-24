import importlib.util
from pathlib import Path
import sys
import unittest
import tempfile
from unittest.mock import patch
root = Path(__file__).resolve().parents[1]/'scripts'
sys.path.insert(0,str(root.parent))
sys.path.insert(0,str(root))
from scripts.lib.committee_proceedings import extract_proceedings
spec = importlib.util.spec_from_file_location('committee_catalogue',root/'committee-catalogue.py')
catalogue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalogue)


class Committees(unittest.TestCase):
    def test_house_study_is_bound_to_submitted_document_and_author(self):
        study = {'url':'https://www.ourcommons.ca/committees/en/TEST/StudyActivity?studyActivityId=123'}
        shell = '<h1 class="study-title-label">Test study</h1><div id="briefs-submitted-item"></div><script>var a = "/committees/en/TEST/StudyActivity/GetBriefs?studyActivityId=123";</script>'
        records = '<div class="brief-item"><div class="name">A and B</div><a class="btn-brief" href="/Content/brief.pdf">Brief</a></div>'
        with patch.object(catalogue,'get',side_effect=[shell,records]):
            result = catalogue.house_briefs(study)
        self.assertEqual(result['links'][0]['submitter'],'A and B')
        self.assertEqual(result['links'][0]['studyUrl'],study['url'])
        self.assertTrue(result['links'][0]['url'].endswith('/Content/brief.pdf'))
    def test_senate_shared_attachment_preserves_distinct_study_relationships(self):
        docs = [{'kind':'submission','url':'https://sencanada.ca/example.pdf','submitter':'A','study':title} for title in ('First','Second')]
        self.assertEqual(len(catalogue.entries('source',docs)['links']),2)

    def test_house_evidence_preserves_order_location_and_speaker(self):
        html = b'''<span class="paratext"><a name="Para100"></a><div><div class="personSpeaking"><b>Dr. Ada Example (University of Ottawa): </b></div>First answer.</div></span><span class="paratext"><a name="Para101"></a><div>Continued answer.</div></span><span class="paratext"><a name="Para102"></a><div><div class="personSpeaking"><b>The Chair: </b></div>Thank you.</div></span>'''
        turns = extract_proceedings(html,'https://www.ourcommons.ca/DocumentViewer/en/45-1/TEST/meeting-1/evidence','en')
        self.assertEqual([x['location'] for x in turns],['100','101','102'])
        self.assertEqual([x['speaker'] for x in turns],['Dr. Ada Example (University of Ottawa)','Dr. Ada Example (University of Ottawa)','The Chair'])
        self.assertEqual([x['text'] for x in turns],['First answer.','Continued answer.','Thank you.'])
        self.assertIsNone(turns[0]['affiliation'])

        french = 'https://www.ourcommons.ca/DocumentViewer/fr/45-1/TEST/reunion-1/temoignages'
        self.assertEqual(extract_proceedings(html, french, 'fr'), turns)

    def test_joint_committee_french_bold_turns_inside_publication_container(self):
        url = 'https://www.parl.ca/DocumentViewer/fr/45-1/REGS/reunion-1/temoignages'
        body = ('<div class="publication-container-content"><div>En-tête</div>'
                '<p><b>Melissa Doyle, cogreffière du comité : </b>Bonjour.</p>'
                '<p><b>M. Davidson : </b>Je propose la candidature du sénateur Woo.</p></div>'
                '<p><b>Menu : </b>Calendrier</p>').encode()
        turns = extract_proceedings(body, url, 'fr')
        self.assertEqual([(t['speaker'], t['text']) for t in turns], [
            ('Melissa Doyle, cogreffière du comité', 'Bonjour.'),
            ('M. Davidson', 'Je propose la candidature du sénateur Woo.'),
        ])

    def test_live_house_witness_turn_shape(self):
        # Derived from ACVA meeting 15, Para9084433 (official House evidence).
        body=b'''<span class="paratext"><a name="Para9084433"></a><div><div class="personSpeaking"><b><a class="PersonSpeakingPopup">Dr. Denise M. Brend</a>: </b></div>Peer support is one of the most effective ways we can help people.</div></span>'''
        turns=extract_proceedings(body,'https://www.ourcommons.ca/DocumentViewer/en/45-1/ACVA/meeting-15/evidence','en')
        self.assertEqual(turns,[{'text':'Peer support is one of the most effective ways we can help people.',
                                'location':'9084433','speaker':'Dr. Denise M. Brend','affiliation':None}])

    def test_live_senate_witness_turn_shape(self):
        # Derived from AEFA 03ev-57228-e (official Senate committee evidence).
        body=b'''<div id="content-viewer-document"><p><b>Rob Stewart, Deputy Minister of International Trade, Global Affairs Canada: </b>We have quite an extensive agenda for trade diversification.</p><p>That has become more important.</p><p><b>Martin Moen, Associate Assistant Deputy Minister, Global Affairs Canada: </b>Thank you for the question.</p></div>'''
        turns=extract_proceedings(body,'https://sencanada.ca/en/content/sen/committee/451/aefa/03ev-57228-e','en')
        self.assertEqual([x['location'] for x in turns],['paragraph-1','paragraph-2','paragraph-3'])
        self.assertEqual(turns[0]['speaker'],'Rob Stewart, Deputy Minister of International Trade, Global Affairs Canada')
        self.assertEqual(turns[1]['speaker'],turns[0]['speaker'])
        self.assertEqual(turns[2]['speaker'],'Martin Moen, Associate Assistant Deputy Minister, Global Affairs Canada')
        self.assertTrue(all(x['affiliation'] is None for x in turns))

    def test_senate_numeric_interim_transcripts_require_evidence_heading(self):
        en=b'''<div id="content-viewer-document"><p><b>EVIDENCE</b></p><p>OTTAWA, Thursday, October 29, 2026</p><p><b>The Deputy Chair: </b>My name is John McNair, the deputy chair of this committee.</p></div>'''
        fr='''<div id="content-viewer-document"><p><b>TÉMOIGNAGES</b></p><p>OTTAWA, le jeudi 29 octobre 2026</p><p><b>Le vice-président : </b>Je m’appelle John McNair et je suis le vice-président de ce comité.</p></div>'''.encode()
        en_turns=extract_proceedings(en,'https://sencanada.ca/en/content/sen/committee/451/agfo/57921-e','en')
        fr_turns=extract_proceedings(fr,'https://sencanada.ca/fr/content/sen/committee/451/agfo/57921-f','fr')
        self.assertEqual(en_turns[0]['speaker'],'The Deputy Chair')
        self.assertIn('My name is John McNair',en_turns[0]['text'])
        self.assertEqual(fr_turns[0]['speaker'],'Le vice-président')
        self.assertIn('Je m’appelle John McNair',fr_turns[0]['text'])
        self.assertEqual(extract_proceedings(b'<div id="content-viewer-document">ordinary publication</div>',
                                             'https://sencanada.ca/en/content/sen/committee/451/agfo/57921-e','en'),[])

    def test_empty_or_unlabelled_publication_body_is_not_fabricated(self):
        self.assertEqual(extract_proceedings(b'<html><body><p>Transcript not available.</p></body></html>','https://example.test','fr'),[])

    def test_publication_kinds_and_relationships_are_normalized(self):
        class Link:
            attrs={'href':'/DocumentViewer/en/45-1/ACVA/meeting-10/evidence','title':'Evidence'}
            def text(self): return 'Evidence'
        item=catalogue.pub(Link(),'https://www.ourcommons.ca/Committees/en/ACVA/Meetings','publication')
        self.assertEqual(item['kind'],'evidence')
        self.assertEqual(item['meetingId'],'10')
        self.assertEqual(item['sourceContext'],'Evidence')

    def test_senate_order_of_reference_response_and_french_notice_kinds(self):
        class Link:
            def __init__(self,href,title): self.attrs={'href':href,'title':title}
            def text(self): return self.attrs['title']
        study=catalogue.pub(Link('/Content/Sen/Committee/451/AEFA/AEFA-C-13-e','2026-03-26'),
                            'https://sencanada.ca/en/committees/aefa/studiesandbills/45-1','studies')
        response=catalogue.pub(Link('/content/sen/committee/451/AEFA/reports/response.pdf','Réponse du gouvernement'),
                               'https://sencanada.ca/fr/committees/AEFA/rapports/45-1','publication')
        notice=catalogue.pub(Link('/fr/committees/AEFA/avisdeconvocation/123/45-1','23 nov. 2026'),
                             'https://sencanada.ca/fr/committees/AEFA/reunions/45-1','meetings')
        self.assertEqual((study['kind'],study['orderOfReferenceId']),('study','C-13'))
        self.assertEqual(response['kind'],'government-response')
        self.assertEqual((notice['kind'],notice['meetingId']),('notice','123'))

    def test_entries_record_terminal_source_totals(self):
        result=catalogue.entries('https://example.test/index',[{'kind':'study','url':'https://example.test/1'}])
        self.assertEqual(result['sourceTotals'],{'rows':1,'uniqueLinks':1})
        self.assertTrue(result['terminalPage']['exhausted'])

    def test_shared_publication_retains_multiple_study_associations(self):
        shared='https://www.ourcommons.ca/DocumentViewer/en/45-1/TEST/meeting-3/evidence'
        rows=[{'kind':'evidence','url':shared,'studyUrl':'https://example.test/study/1'},
              {'kind':'evidence','url':shared,'studyUrl':'https://example.test/study/2'}]
        self.assertEqual(len(catalogue.entries('source',rows)['links']),2)

    def test_house_empty_study_is_distinct_from_unrecognized_page(self):
        study={'url':'https://www.ourcommons.ca/committees/en/TEST/StudyActivity?studyActivityId=1'}
        with patch.object(catalogue,'get',return_value='<html><h1 class="study-title-label">Published title</h1></html>'):
            result=catalogue.house_briefs(study)
        self.assertEqual(result['coverage']['status'],'publisher-omits-submissions-section')
        with patch.object(catalogue,'get',return_value='<html><h1>Unexpected</h1></html>'):
            with self.assertRaisesRegex(ValueError,'study title'):
                catalogue.house_briefs(study)

    def test_resume_reads_interrupted_partial_and_preserves_completed_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            partial=Path(temp)/'catalogue.partial.json'
            partial.write_text('{"completed":false,"indexes":{"done":{"links":[]},"retry":{"error":"temporary"}}}')
            result=catalogue.load_resume_checkpoint(partial)
        self.assertEqual(result['indexes']['done'],{'links':[]})
        self.assertEqual(result['indexes']['retry'],{'error':'temporary'})
        with tempfile.TemporaryDirectory() as temp:
            absent=Path(temp)/'catalogue.partial.json'
            with self.assertRaisesRegex(RuntimeError,'No interrupted partial'):
                catalogue.load_resume_checkpoint(absent)

    def test_house_work_index_keeps_the_study_title_not_the_participation_action(self):
        page='''<html><body><div>45th Parliament, 1st Session</div>
          <a href="/committees/en/TEST/StudyActivity?studyActivityId=123">Diagnostic Imaging Capacity</a>
          <a href="/committees/en/TEST/StudyActivity?studyActivityId=123">Participate</a>
        </body></html>'''
        with patch.object(catalogue, 'get', return_value=page):
            result = catalogue.house_index(
                {'code': 'TEST', 'url': 'https://www.ourcommons.ca/committees/en/TEST'}, 'en', 'Work')
        studies = [item for item in result['links'] if item['kind'] == 'study']
        self.assertTrue(studies)
        self.assertEqual({item['title'] for item in studies}, {'Diagnostic Imaging Capacity'})

    def test_senate_brief_table_follows_publisher_page_links(self):
        shell='''<html><div data-ajaxpartial-action="GetTablePartialView" data-ajaxpartial-data='{"tableName":"Briefs","committeeId":1,"selectedSession":"45-1"}'></div></html>'''
        page1='''<div id="table-print"><table><tr><td>Org</td><td>First</td><td>x</td><td>date</td><td><a href="/Content/Sen/Committee/451/TEST/briefs/first.pdf">PDF</a></td></tr></table></div><nav class="sen-pagination"><a href="#?session=45-1&amp;CommitteeID=1&amp;PageSize=10&amp;p=2">2</a></nav>'''
        page2='''<div id="table-print"><table><tr><td>Org</td><td>Second</td><td>x</td><td>date</td><td><a href="/Content/Sen/Committee/451/TEST/briefs/second.pdf">PDF</a></td></tr></table></div>'''
        with patch.object(catalogue,'get',side_effect=[shell,page1,page2]) as fetch:
            result=catalogue.senate_index({'code':'TEST','url':'https://sencanada.ca/en/committees/test/45-1'},'en','briefs')
        self.assertEqual(len(result['links']),2)
        self.assertEqual(result['terminalPage']['pages'][-1]['pageNumber'],2)
        self.assertTrue(result['terminalPage']['pages'][-1]['exhausted'])
        self.assertTrue(result['terminalPage']['exhausted'])
        self.assertEqual(fetch.call_count,3)

    def test_senate_study_table_ignores_navigation_and_keeps_order_reference(self):
        shell='''<html><div data-ajaxpartial-action="GetTablePartialView" data-ajaxpartial-data='{"tableName":"Studies","committeeId":1,"selectedSession":"45-1"}'></div></html>'''
        table='''<div id="table-print"><a href="/en/committees/test/briefs/45-1#?OrderOfReferenceID=123">Briefs and Other Documents</a><a href="/Content/Sen/Committee/451/TEST/TEST-C-13-e">2026-03-26</a></div>'''
        with patch.object(catalogue,'get',side_effect=[shell,table]):
            result=catalogue.senate_index({'code':'TEST','url':'https://sencanada.ca/en/committees/test/45-1'},'en','studies')
        self.assertEqual(len(result['links']),1)
        self.assertEqual(result['links'][0]['kind'],'study')
        self.assertEqual(result['links'][0]['orderOfReferenceId'],'C-13')

    def test_senate_study_group_links_report_meeting_and_order_id(self):
        for lang,slug,notice,minutes in [
            ('en','AEFA-C-13-e','noticeofmeeting','33mn-57673-e'),
            ('fr','AEFA-SS-1-f','avisdeconvocation','33mn-57673con-f')]:
            language_path='en' if lang=='en' else 'fr'
            shell=f'''<html><div data-ajaxpartial-action="GetTablePartialView" data-ajaxpartial-data='{{"tableName":"Studies","committeeId":1,"selectedSession":"45-1"}}'></div></html>'''
            table=f'''<div id="table-print"><div class="cmt-site_v2-studybills-table-study-item"><h3 class="cmt-site_v2-studybills-table-study-item-name">Study of a published order</h3><div id="id-study-691525"><a href="/{language_path}/Content/SEN/Committee/451/TEST/{slug}">2026-03-26</a><a href="/{language_path}/committees/TEST/Rapport/123/45-1">First Report</a><a href="/{language_path}/committees/test/memoires/45-1#?sessionFilter=45-1&amp;OrderOfReferenceID=691525">Briefs and Other Documents</a><a href="/{language_path}/content/sen/committee/451/test/33ev-57673-{lang}">Transcripts</a><a href="/{language_path}/content/sen/committee/451/test/{minutes}">Minutes</a><a href="/{language_path}/committees/test/{notice}/693909/45-1">Meeting notice</a></div></div></div>'''
            committee={'code':'TEST','url':f'https://sencanada.ca/{language_path}/committees/test/45-1'}
            with patch.object(catalogue,'get',side_effect=[shell,table]):
                result=catalogue.senate_index(committee,lang,'studies')
            by_kind={item['kind']:item for item in result['links']}
            self.assertEqual(set(by_kind),{'study','report','evidence','minutes','notice'})
            for item in by_kind.values():
                self.assertEqual(item['studyId'],'691525')
                self.assertEqual(item['orderOfReferenceId'],'691525')
                self.assertIn('Study of a published order',item['studyTitle'])
            self.assertEqual(by_kind['report']['reportId'],'123')
            self.assertNotIn('meetingUrl',by_kind['minutes'])
            self.assertEqual(by_kind['notice']['meetingId'],'693909')
            self.assertEqual(result['relatedOrderReferences'][0]['orderOfReferenceId'],'691525')

    def test_senate_reports_follow_official_response_relationship(self):
        shell='''<html><div data-ajaxpartial-action="GetCommitteeReports" data-ajaxpartial-data='{"committeeId":1,"selectedSession":"45-1"}'></div></html>'''
        reports='''<section class="sc-committee-reports"><ul><li class="cmt-li-list-report"><a href="/en/committees/TEST/report/123/45-1"><strong>First Report</strong></a></li><li class="cmt-ul-list-report-2"><ul><li><a href="/content/sen/committee/451/TEST/reports/response.pdf">Government response</a></li></ul></li></ul></section>'''
        with patch.object(catalogue,'get',side_effect=[shell,reports]):
            result=catalogue.senate_index({'code':'TEST','url':'https://sencanada.ca/en/committees/test/45-1'},'en','reports')
        by_kind={item['kind']:item for item in result['links']}
        self.assertIn('report',by_kind)
        self.assertIn('government-response',by_kind)
        self.assertEqual(by_kind['government-response']['reportUrl'],by_kind['report']['url'])


if __name__=='__main__':
    unittest.main()
