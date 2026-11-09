"""Run standalone; stubs ComfyUI/torch while exercising the real FFmpeg encoder."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

settings = types.SimpleNamespace(disable_metadata=False)
root = tempfile.TemporaryDirectory()
sys.modules['folder_paths'] = types.SimpleNamespace(get_output_directory=lambda: root.name)
sys.modules['comfy'] = types.ModuleType('comfy')
sys.modules['comfy.cli_args'] = types.SimpleNamespace(args=settings)
sys.modules['comfy.model_management'] = types.SimpleNamespace(throw_exception_if_processing_interrupted=lambda: None)
sys.modules['torch'] = types.SimpleNamespace(float32='float32')
package=types.ModuleType('magik_video_grid_test')
package.__path__=[str(Path(__file__).resolve().parents[1])]
sys.modules[package.__name__]=package
spec = importlib.util.spec_from_file_location('magik_video_grid_test.video_grid', Path(__file__).resolve().parents[1] / 'video_grid.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Frames:
    def __init__(self, a): self.a=a; self.shape=a.shape
    def __iter__(self): return (Frames(f) for f in self.a)
    def __getitem__(self, k): return Frames(self.a[k])
    def detach(self): return self
    def to(self, device, dtype):
        assert device == 'cpu' and dtype == 'float32'
        return Frames(self.a.astype(np.float32))
    def numpy(self): return self.a

class Tests(unittest.TestCase):
    def setUp(self):
        settings.disable_metadata=False
        self.frames=Frames(np.random.default_rng(1).random((8,31,47,4),dtype=np.float32))
        self.state=dict(session=m.uuid.uuid4().hex,cols=2,rows=1,xi=0,yi=0,xLabels=['1','2'],yLabels=[''])
    def execute(self, **kw):
        return m.MagikVideoGrid().execute(self.frames,24,20,json.dumps(self.state),**kw)
    def test_encode_and_metadata(self):
        result=self.execute(prompt={'is_changed':[float('nan'),float('inf')]})
        path=Path(result['result'][1])
        info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(path)]))['streams'][0]
        self.assertEqual((info['width'],info['height'],info['nb_frames']),(48,32,'8'))
        self.assertEqual(info['codec_name'],'h264')
        self.assertIs(result['result'][0],self.frames)
        data=json.loads(path.with_suffix('.json').read_text(),parse_constant=lambda x:self.fail(x))
        self.assertEqual(data['prompt']['is_changed'],[None,None])
        self.assertEqual(len(list(path.parent.iterdir())),2)
    def test_disabled_metadata(self):
        settings.disable_metadata=True
        r=self.execute(prompt={'secret':'prompt'},extra_pnginfo={'workflow':{'secret':'workflow'}})
        data=json.loads(Path(r['result'][1]).with_suffix('.json').read_text())
        self.assertNotIn('prompt',data); self.assertNotIn('workflow',data)
    def test_invalid_state(self):
        for bad in [dict(self.state,session=None),dict(self.state,session=32),dict(self.state,session='../escape'),dict(self.state,xi=2),dict(self.state,cols=65),dict(self.state,xLabels=[]),dict(self.state,yi=True)]:
            with self.subTest(bad=bad), self.assertRaises(ValueError): m.checked_state(json.dumps(bad))
    def test_interrupt_cleans_up(self):
        count=0
        def interrupt():
            nonlocal count
            count+=1
            if count==2: raise InterruptedError('user interrupt')
        with patch.object(m,'throw_exception_if_processing_interrupted',interrupt):
            with self.assertRaises(InterruptedError): self.execute()
        directory=Path(root.name)/'magik_video_grid'/self.state['session']
        self.assertEqual(list(directory.iterdir()),[])
    def test_encoder_error_and_missing_ffmpeg(self):
        with patch.object(m.shutil,'which',lambda _:None):
            with self.assertRaisesRegex(RuntimeError,'FFmpeg is required'): self.execute()
        with patch.object(m.shutil,'which',lambda _:'/bin/false'):
            with self.assertRaises(RuntimeError): self.execute()
        directory=Path(root.name)/'magik_video_grid'/self.state['session']
        self.assertEqual(list(directory.iterdir()),[])

class ExportTests(unittest.TestCase):
    def setUp(self):
        settings.disable_metadata=False
        self.state=dict(session=m.uuid.uuid4().hex,cols=2,rows=2,xi=0,yi=0,
                        xLabels=['red;[x]','green'],yLabels=['blue','hold final'],
                        xName='X cfg',yName='Y seed')
    def cells(self, export=False):
        colors=[(1,0,0),(0,1,0),(0,0,1),(1,1,0)]
        results=[]
        for index,count in enumerate([6,12,9,3]):
            array=np.zeros((count,31,47,3),dtype=np.float32)
            array[:]=colors[index]
            if index==3: array[0]=(1,0,1)
            state=dict(self.state,xi=index%2,yi=index//2)
            results.append(m.MagikVideoGrid().execute(Frames(array),12,20,json.dumps(state),
                           export_grid=export,tile_width=128,tile_height=72))
        return results
    def probe(self,path):
        return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(path)]))['streams'][0]
    def test_auto_export_and_longest_hold(self):
        results=self.cells(export=True)
        self.assertTrue(all(r['result'][2]=='' for r in results[:3]))
        path=Path(results[-1]['result'][2])
        stream=self.probe(path)
        self.assertEqual((stream['width'],stream['height'],stream['nb_frames']),(280,344,'3'))
        directory=path.parent
        longest=m.encode_grid(directory,self.state,12,20,128,72,'longest_hold')
        self.assertEqual(longest['frame_count'],12)
        self.assertEqual(self.probe(path)['nb_frames'],'12')
        raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-vf',r'select=eq(n\,11)',
             '-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
        pixels=np.frombuffer(raw,dtype=np.uint8).reshape(344,280,3)
        for x,y,color in [(72,132,(255,0,0)),(208,132,(0,255,0)),(72,300,(0,0,255)),(208,300,(255,255,0))]:
            self.assertTrue(np.max(np.abs(pixels[y,x].astype(int)-np.array(color)))<35,(x,y,pixels[y,x]))
        # The header is retained above the clip, with visible light label pixels.
        self.assertGreater(int(pixels[8:88,8:136].max()),200)
        self.assertEqual(json.loads(path.with_suffix('.json').read_text())['duration_mode'],'longest_hold')
        self.assertFalse(list(directory.glob('.grid-export-*')))
    def test_export_waits_for_missing_and_rejects_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(m.encode_grid(directory,self.state,12,20,128,72))
        from magik_video_grid_test.grid_export import export_geometry
        for args in [(17,1,128,72),(16,1,1280,72),(2,2,129,72)]:
            with self.subTest(args=args),self.assertRaises(ValueError): export_geometry(*args)
    def test_mixed_fps_and_resolution(self):
        results=self.cells()
        directory=Path(results[-1]['result'][1]).parent
        frames=Frames(np.ones((6,19,65,3),dtype=np.float32))
        m.MagikVideoGrid().execute(frames,24,20,json.dumps(self.state))
        short=m.encode_grid(directory,self.state,24,20,128,72,'shortest')
        self.assertEqual(short['frame_count'],6)
        long=m.encode_grid(directory,self.state,24,20,128,72,'longest_hold')
        self.assertEqual(long['frame_count'],24)
        self.assertEqual(self.probe(directory/'grid.mp4')['r_frame_rate'],'24/1')
    def test_export_error_keeps_cell_result(self):
        state=dict(self.state,cols=1,rows=1,xLabels=['x'],yLabels=['y'])
        with patch.object(m,'encode_grid',side_effect=RuntimeError('encoder unavailable')):
            result=m.MagikVideoGrid().execute(Frames(np.ones((2,16,16,3),dtype=np.float32)),12,20,json.dumps(state),export_grid=True)
        self.assertTrue(Path(result['result'][1]).exists())
        self.assertEqual(result['ui']['magik_video_export_error'],['encoder unavailable'])
    def test_interrupt_export_cleanup(self):
        results=self.cells()
        directory=Path(results[-1]['result'][1]).parent
        module=sys.modules['magik_video_grid_test.grid_export']
        with patch.object(module,'throw_exception_if_processing_interrupted',side_effect=InterruptedError('stop')):
            with self.assertRaises(InterruptedError): m.encode_grid(directory,self.state,12,20,128,72)
        self.assertFalse((directory/'grid.mp4').exists())
        self.assertFalse(list(directory.glob('.grid-export-*')))

if __name__ == '__main__': unittest.main()
