import asyncio, importlib.util, pathlib, time
spec = importlib.util.spec_from_file_location("f", pathlib.Path(__file__).parent.parent / "impact_wait_filter.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def test_last_user_text():
    assert m.last_user_text([{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}, {"role": "user", "content": " c "}]) == "c"
    assert m.last_user_text([{"role": "user", "content": [{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {}}]}]) == "look"
    assert m.last_user_text([]) == ""

def test_embed_escapes_and_marks():
    h = m.embed_html("my-site", 'x" onload="alert(1)<script>', m.DEFAULT_ENDPOINT, "dark", now=time.time())
    assert m.MARK in h and 'theme="dark"' in h
    assert 'onload="alert' not in h and "<script>alert" not in h and "&quot; onload=&quot;" in h

class Emitter:
    def __init__(self): self.events = []
    async def __call__(self, e): self.events.append(e)

def run(c): return asyncio.run(c)

def test_inlet_requires_site_and_query():
    f = m.Filter(); em = Emitter()
    run(f.inlet({"messages": [{"role": "user", "content": "hi"}]}, None, em)); assert em.events == []  # no site
    f.valves.site = "Bad Site!"; run(f.inlet({"messages": [{"role": "user", "content": "hi"}]}, None, em)); assert em.events == []
    f.valves.site = "my-site"; run(f.inlet({"messages": []}, None, em)); assert em.events == []  # no query
    body = {"messages": [{"role": "user", "content": "hi"}]}
    out = run(f.inlet(body, None, em)); assert out is body and len(em.events) == 1 and em.events[0]["type"] == "embeds"
    f.valves.enabled = False; run(f.inlet(body, None, em)); assert len(em.events) == 1

def test_inlet_never_raises():
    f = m.Filter(); f.valves.site = "my-site"
    async def boom(e): raise RuntimeError("socket down")
    body = {"messages": [{"role": "user", "content": "hi"}]}
    assert run(f.inlet(body, None, boom)) is body

def test_user_opt_out():
    f = m.Filter(); f.valves.site = "my-site"; em = Emitter()
    run(f.inlet({"messages": [{"role": "user", "content": "hi"}]}, {"valves": f.UserValves(show_sponsored_line=False)}, em))
    assert em.events == []

if __name__ == "__main__":
    n = 0
    for k, v in list(globals().items()):
        if k.startswith("test_"): v(); n += 1; print("PASS", k)
    print(f"{n}/{n} passed")
