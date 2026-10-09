"""詳細設計のMermaid原本・SVG・PDFを同じ図データから生成する。外部通信なし。"""
from pathlib import Path
import json, re, math
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "詳細設計"
FIG = OUT / "図"
FIG.mkdir(parents=True, exist_ok=True)
schema = json.loads((OUT / "schema.json").read_text(encoding="utf-8"))
progress = json.loads((ROOT / "docs/implementation-progress.json").read_text(encoding="utf-8"))
pdfmetrics.registerFont(TTFont("JP", "C:/Windows/Fonts/meiryo.ttc", subfontIndex=0))
W, H = 1200, 850
PINK, INK, GRAY, BG = "#993556", "#2C2C2A", "#5F5E5A", "#F7F5F0"
pages = []

def width(s, size):
    return pdfmetrics.stringWidth(s, "JP", size)

def wrapped(s, maxwidth, size):
    lines = []
    for paragraph in str(s).split("\n"):
        current = ""
        for char in paragraph:
            if current and width(current + char, size) > maxwidth:
                lines.append(current)
                current = char
            else:
                current += char
        lines.append(current)
    return lines

class Diagram:
    def __init__(self, slug, title, subtitle):
        self.slug, self.title, self.ops = slug, title, []
        self.rect(0, 0, W, H, BG, BG)
        self.text(36, 43, title, 27, PINK)
        self.text(36, 77, subtitle, 13, GRAY)
        self.line([(36, 94), (1164, 94)], "#D3D1C7")
        self.text(36, 823, "にこまる | 実装連動の詳細設計 | 2026-10-09 | 学校発表・模擬データ用", 11, GRAY)
        self.text(1120, 823, str(len(pages) + 1).zfill(2), 12, GRAY)
        pages.append(self)

    def rect(self, x, y, w, h, fill="white", stroke="#D3D1C7"):
        self.ops.append(("rect", x, y, w, h, fill, stroke))

    def text(self, x, y, value, size=15, color=INK):
        self.ops.append(("text", x, y, str(value), size, color))

    def lines(self, x, y, value, maxwidth, size=15, leading=22):
        lines = wrapped(value, maxwidth, size)
        for index, line in enumerate(lines):
            self.text(x, y + index * leading, line, size)
        return len(lines) * leading

    def line(self, points, color="#89857B", arrow=False):
        self.ops.append(("line", points, color, arrow))

    def box(self, x, y, w, h, title, detail="", fill="white"):
        self.rect(x, y, w, h, fill)
        self.text(x + 14, y + 26, title, 17, PINK)
        if detail:
            self.lines(x + 14, y + 52, detail, w - 28, 14, 20)

    def flow(self, nodes, edges):
        for a, b, label in edges:
            ax, ay, aw, ah, *_ = nodes[a]
            bx, by, bw, bh, *_ = nodes[b]
            if by < ay and abs((ax+aw/2)-(bx+bw/2)) < 20:
                if a == 'f':
                    points = [(ax,ay+ah/2),(ax-55,ay+ah/2),(ax-55,by+bh/2),(bx,by+bh/2)]
                else:
                    points = [(ax+aw/2,ay),(ax+aw/2,(ay+by+bh)/2),(bx+bw/2,(ay+by+bh)/2),(bx+bw/2,by+bh)]
            elif by >= ay + ah:
                points = [(ax + aw/2, ay + ah), (ax + aw/2, (ay+ah+by)/2), (bx+bw/2, (ay+ah+by)/2), (bx+bw/2, by)]
            elif bx < ax:
                points = [(ax, ay+ah/2), ((ax+bx+bw)/2, ay+ah/2), ((ax+bx+bw)/2, by+bh/2), (bx+bw, by+bh/2)]
            else:
                points = [(ax+aw, ay+ah/2), ((ax+aw+bx)/2, ay+ah/2), ((ax+aw+bx)/2, by+bh/2), (bx, by+bh/2)]
            self.line(points, arrow=True)
            if label:
                xx, yy = points[1]
                size = 11
                self.rect(xx - 5, yy - 17, width(label, size) + 10, 20, BG, BG)
                self.text(xx, yy - 2, label, size, GRAY)
        for x, y, w, h, title, detail in nodes.values():
            self.box(x, y, w, h, title, detail)
        mermaid = ["flowchart TD"]
        for key, node in nodes.items():
            label = (node[4] + "<br/>" + node[5]).replace("\n", "<br/>").replace('"', "'")
            mermaid.append(f'  {key}["{label}"]')
        for a, b, label in edges:
            mermaid.append(f'  {a} -->|"{label}"| {b}' if label else f'  {a} --> {b}')
        self.source("\n".join(mermaid))

    def source(self, text):
        (FIG / (self.slug + ".mmd")).write_text(text + "\n", encoding="utf-8")

    def svg(self):
        elements = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img">',
                    f"<title>{escape(self.title)}</title>",
                    '<style>text{font-family:Meiryo,"Noto Sans JP",sans-serif}</style>']
        for op in self.ops:
            if op[0] == "rect":
                _, x,y,w,h,fill,stroke = op
                elements.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}"/>')
            elif op[0] == "text":
                _, x,y,s,size,color = op
                elements.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}">{escape(s)}</text>')
            else:
                _, points,color,arrow = op
                elements.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in points)}" fill="none" stroke="{color}" stroke-width="1.5"/>')
                if arrow:
                    elements.append(f'<polygon points="{" ".join(f"{x},{y}" for x,y in arrowhead(points))}" fill="{color}"/>')
        elements.append("</svg>")
        (FIG / (self.slug + ".svg")).write_text("\n".join(elements), encoding="utf-8")

def arrowhead(points):
    x,y = points[-1]
    px,py = points[-2]
    angle = math.atan2(y-py, x-px)
    return [(x,y), (x-9*math.cos(angle-0.45),y-9*math.sin(angle-0.45)), (x-9*math.cos(angle+0.45),y-9*math.sin(angle+0.45))]

d = Diagram("01-構成と責任", "01  構成と責任分担", "利用者の通信と限定的なシステム通信を分離。ローカルLLMを公開しない。")
d.flow({
    "client": (36,130,305,115,"ブラウザ / ホーム画面アプリ","couple / planner / admin\nService Workerは機微情報を保存しない"),
    "web": (434,130,330,115,"Next.js / Vercel","画面・入力検証・認証・Origin検証\nRLSクライアントによる読み書き"),
    "auth": (855,130,310,115,"Supabase Auth","OTP / パスワード / セッション\nactiveプロフィールと照合"),
    "db": (434,355,330,115,"Supabase DB / Storage","RPCの原子性 + RLSの行境界\n非公開ファイル + 短命署名URL"),
    "notify": (855,355,310,115,"LINE / Resend","通知本文を外部へ送信する専用出口\n送信結果・上限・代替を管理"),
    "cron": (36,355,305,115,"pg_cron / GitHub Actions","定期登録 + 共有secret認証\n容量・監視・削除・通知・回収"),
    "worker": (434,580,330,115,"校内・自宅のAI worker","専用DBロールでpull / 30秒周期\nService Roleを渡さない"),
    "ollama": (855,580,310,115,"Ollama（ローカル）","必要な最小入力 / JSON出力\n人が確認・修正して採用"),
}, [("client","web","HTTPS"),("web","auth","本人確認"),("web","db","JWT / RLS"),("web","notify","必要な通知のみ"),("cron","db","限定RPC"),("worker","db","ジョブ取得・結果"),("worker","ollama","ローカル推論")])
d.lines(40,749,"学校の最終発表・デモが対象。常時本番運用/商用SLAは今回の予定に含めない。",1100,14)

d = Diagram("02-画面遷移", "02  公開画面と役割別の画面遷移", "31画面ID。URL・機能との完全対応は「機能画面対応.md」を参照。")
for i, screen in enumerate(progress["screens"][:4]):
    d.box(36+i*286,125,264,78,screen["id"]+" "+screen["title"],"未ログイン可")
groups = [
    ("couple",["M01","M02","M03","M04","M05","M06"]),
    ("planner / staff",["D01","K01","K02","K03","K04","K05","D02","D03","D04","D05","N01"]),
    ("式場管理 admin",["T01","T02","T03","U01","U02","U03","U04"]),
    ("system_admin",["S01","S02","S03"]),
]
screenmap = {s["id"]:s for s in progress["screens"]}
mmd = ["flowchart TD",'  P01["P01 ログイン"] --> ROLE{"active / role"}']
d.rect(36,218,1128,30,"#FBEAF0","#FBEAF0")
d.text(48,239,"認証成功後のactive / roleで着地点を決定。各グループ内の操作もAPIとRLSで範囲を制限する。",13,PINK)
for i,(name, ids) in enumerate(groups):
    x = 36+i*286
    d.line([(x+132,248),(x+132,267)],arrow=True)
    d.box(x,267,264,358,name)
    for j,sid in enumerate(ids):
        d.text(x+14,327+j*25,sid+"  "+screenmap[sid]["title"],13)
        mmd.append(f'  {sid}["{sid} {screenmap[sid]["title"]}"]')
    landing = {"couple":"M01","planner / staff":"D01","式場管理 admin":"D01","system_admin":"S03"}[name]
    mmd.append(f'  ROLE -->|"{name}"| {landing}')
for a,b in [("M01","M02"),("M02","M03"),("M01","M04"),("M01","M05"),("M01","M06"),
            ("D01","K01"),("K01","K03"),("K01","K02"),("K02","K04"),("K02","K05"),
            ("K02","D02"),("K02","D03"),("K02","D04"),("K02","D05"),
            ("T01","T02"),("U01","U02"),("U01","U03"),("U01","U04"),("S01","S02")]:
    mmd.append(f'  {a} --> {b}')
mmd += ['  P02["P02 招待登録"] --> M01','  P03["P03 パスワード設定"] --> P01','  P04["P04 エラー"]',
        '  ROLE -->|"未認証"| P01','  ROLE -->|"権限不足"| P04']
d.source("\n".join(mmd))
d.box(36,658,1128,114,"拒否・再操作","API: 未認証401 / 不正Origin・権限不足403 / 存在しない・不可視404。\n期限切れ招待は再発行を依頼。OTPのリンク着地が別ブラウザで失敗した場合は6桁コードを利用。\n画面の権限不足は役割別着地点へ戻す。APIの403と画面redirectを混同しない。")

d = Diagram("03-コアシーケンス", "03  案件登録から提出物の確認まで", "DBの確定とAuth/Storage/外部送信は別境界。失敗時の補償を明記する。")
actors = [("staff","プランナー"),("api","Next.js API"),("db","DB / RPC"),("auth","Auth / 通知"),("couple","新郎新婦")]
xs = [115,350,585,820,1055]
for (key,label),x in zip(actors,xs):
    d.box(x-80,125,160,55,label)
    d.line([(x,180),(x,731)],"#D3D1C7")
messages = [
    ("staff","api","案件入力 / POST cases"),
    ("api","db","create_wedding_case: 案件・2招待・履歴を一括確定"),
    ("db","api","201用のID / URLの平文はアプリが1度だけ返す"),
    ("staff","api","別要求で宿題割当・招待送付"),
    ("api","auth","通知送信（未構成/失敗は発行成功と区別）"),
    ("couple","api","招待token + 初回登録情報"),
    ("api","db","consume_invitation: 期限/回数/失効を原子的検証"),
    ("api","auth","Auth作成 → 失敗時はrestore_invitation"),
    ("couple","api","提出（ファイルは先にStorageへ）"),
    ("api","db","submit_task_atomic / 最新提出を更新"),
    ("staff","api","確認 または 不備コメント"),
    ("api","db","review_submission: 競合検査・状態更新"),
]
mmd = ["sequenceDiagram"]+[f"  participant {key} as {label}" for key,label in actors]
lookup = dict(zip([a[0] for a in actors],xs))
for i,(a,b,text) in enumerate(messages):
    y = 214+i*42
    d.line([(lookup[a],y),(lookup[b],y)],arrow=True)
    textx = min(lookup[a],lookup[b])+6
    d.text(textx,y-7,text,11)
    mmd.append(f"  {a}->>{b}: {text}")
d.source("\n".join(mmd))
d.text(36,779,"不備ありは再提出へ。AI案は任意の補助であり、提出/確認/通知の確定を自動代行しない。",14)

d = Diagram("04-宿題と提出状態", "04  宿題・提出の状態遷移", "案件宿題の現在状態と、提出バージョンごとのreview_statusを分ける。")
d.flow({
    "n": (40,145,235,100,"not_started","未着手"),
    "s": (380,145,235,100,"submitted","確認待ち"),
    "c": (875,145,275,100,"confirmed","プランナーが確認"),
    "f": (380,370,235,100,"needs_fix","不備コメント → 再提出"),
    "w": (40,580,235,100,"waived","staffが対応不要にする"),
    "draft": (710,370,440,100,"task_submissions: draft","一時保存は本人単位。相手の提出を妨げない"),
    "versions": (710,580,440,100,"提出バージョンを追加","draft / submitted / needs_fix / confirmed\n最新提出ポインタをRPCで競合制御"),
}, [("n","s","提出"),("s","c","確認"),("s","f","不備"),("f","s","再提出"),("n","w","免除"),("draft","versions","提出として確定")])
d.lines(40,742,"旧提出の確認操作は最新状態と照合し409を返す。画面だけで状態を更新せずRPCを正本とする。",1100,14)

d = Diagram("05-招待と利用者状態", "05  招待の利用可能条件と利用者の状態", "招待にはstatus列を足さず、期限・回数・取消列から状態を導出する。")
d.flow({
    "issued": (40,145,290,104,"招待発行","token_hashのみ保存\n平文URLは発行応答の1回のみ"),
    "check": (450,145,310,104,"consume_invitation","purpose / expires_at / revoked_at\nuse_count < max_uses"),
    "used": (880,145,280,104,"登録・消費","Auth / profileを作成\n失敗はrestore_invitation"),
    "revoked": (40,380,290,104,"期限切れ / 失効 / 上限","消費不可。K02で再発行\n旧URLを再び有効にしない"),
    "invited": (450,380,310,104,"invited","初回パスワード設定待ち\n業務RLSのactive条件を満たさない"),
    "active": (880,380,280,104,"active","業務操作可能\nvenue / caseのRLSは引き続き適用"),
    "suspended": (450,610,310,104,"suspended","管理者が停止 / 復帰\n担当引継ぎを確認"),
    "deleted": (880,610,280,104,"deleted","論理削除\n認証済みでも業務APIは拒否"),
}, [("issued","check","URL利用"),("check","used","条件一致"),("issued","revoked","時間/取消"),("invited","active","設定完了"),("active","suspended","停止"),("active","deleted","削除")])
d.source((FIG / (d.slug+".mmd")).read_text(encoding="utf-8")+"\n  suspended -->|復帰| active\n")
d.text(40,774,"公開APIもOrigin・レート制限を維持。アカウントの存在を認証エラー文言から推測できないようにする。",14)

d = Diagram("06-通知と定期処理", "06  通知の選択・送信結果と定期処理", "上限判定はDBで原子的に予約。失敗と未送信を「送信済み」にしない。")
d.flow({
    "queue": (40,140,280,110,"notifications: queued","新規通知 / 日次リマインド\nアプリ内通知は外部送信なし"),
    "choose": (445,140,315,110,"チャネル選択","LINE紐付け + overdue / needs_fix\n案件あり + claim_line_quota成功"),
    "line": (880,140,280,110,"LINE送信","送信枠内の重要通知"),
    "email": (445,365,315,110,"メールへ代替","未紐付け / 上限 / 対象外\nResend構成と送信結果を確認"),
    "result": (880,365,280,110,"sent / failed","notification_logsに結果\nswitch reasonを残す"),
    "batch": (40,590,315,115,"定期登録","register_scheduled_jobs\nアプリURL更新で登録し直す"),
    "internal": (445,590,315,115,"内部API認証","x-internal-cron-secret必須\nユーザーCookieに依存しない"),
    "record": (880,590,280,115,"batch_runs / system_alerts","開始・終了・件数・失敗段階\n監視条件の重複/復旧を管理"),
}, [("queue","choose","外部通知"),("choose","line","条件一致"),("choose","email","条件不一致"),("line","result","結果"),("email","result","結果"),("batch","internal","定期実行"),("internal","record","記録")])
d.lines(40,755,"通知の送信失敗は記録し運用で再操作。LINEプロバイダ障害を無条件にメール再送する設計ではない。",1100,13)

d = Diagram("07-AI非同期と縮退", "07  AIジョブの非同期処理と停止時の動作", "AIは任意の補助。生成結果を人が確認・修正してから業務へ反映する。")
d.flow({
    "input": (40,140,280,105,"画面 / 業務イベント","必要最小限の入力を整形\n要求を同期推論で待たせない"),
    "queued": (445,140,315,105,"queued","worker専用RPCで取得\npromptはDB設定から解決"),
    "processing": (880,140,280,105,"processing","Ollama / JSON検証\n30秒周期のpull"),
    "done": (445,365,315,110,"done","出力は下書き / 候補\nconfirmed または discarded"),
    "human": (880,365,280,110,"人の確認・修正","分類/文面/準備シート/起票案\n自動送信・自動承認しない"),
    "reclaim": (40,590,280,110,"滞留回収","30分超のprocessingを回収\nattempts < 3ならqueuedへ"),
    "failed": (445,590,315,110,"failed / 利用不可","上限到達、設定不足等を表示\n心拍10分超で補助利用不可"),
    "manual": (880,590,280,110,"通常操作を継続","手入力・確認・提出・通知は利用可\nAIの停止で主導線を止めない"),
}, [("input","queued","投入"),("queued","processing","claim / lock"),("processing","done","妥当な出力"),("done","human","採用前"),("processing","reclaim","タイムアウト"),("reclaim","failed","上限到達"),("failed","manual","縮退")])
d.source((FIG/(d.slug+".mmd")).read_text(encoding="utf-8")+"\n  reclaim -->|上限未満| queued\n  human -->|採用| confirmed\n  human -->|破棄| discarded\n")
d.text(40,770,"FAQ/RAG、リスケジュール案、引継ぎサマリー、セット提案、翻訳は条件付き拡張で今回対象外。",13)

tablemap = {t["name"]:t for t in schema["tables"]}
groups = [
    ("08-ER-案件と利用者","案件と利用者",["venues","user_profiles","plan_types","wedding_cases","couple_profiles","case_invitations","case_guests"]),
    ("09-ER-宿題と提出","宿題と提出",["task_templates","plan_task_templates","case_tasks","task_submissions","storage_files","timeline_items"]),
    ("10-ER-進行支援","進行支援",["risk_rules","risk_score_snapshots","communication_logs","follow_logs","meeting_notes","meeting_sheets"]),
    ("11-ER-通知とLINE","通知とLINE",["notifications","notification_logs","notification_settings","notification_quota_counters","line_link_nonces","line_webhook_events"]),
    ("12-ER-AIと運用","AIと運用",["ai_jobs","ai_prompt_templates","ai_worker_heartbeats","audit_logs","auth_rate_limits","batch_runs","usage_snapshots","system_alerts"]),
]
assert sorted(t for _,_,tables in groups for t in tables) == sorted(tablemap)
all_mermaid = ["erDiagram"]
for t in schema["tables"]:
    all_mermaid.append("  "+t["name"]+" {")
    for c in schema["columns"]:
        if c["table_name"] != t["name"]: continue
        keys = []
        for constraint in schema["constraints"]:
            if constraint["table_name"] != t["name"]: continue
            head = constraint["definition"].split(")")[0]
            if re.search(r"\b"+re.escape(c["column_name"])+r"\b",head):
                if constraint["type"] == "p": keys.append("PK")
                if constraint["type"] == "f": keys.append("FK")
        datatype = c["data_type"].replace(" ","_").replace("[]","_array")
        all_mermaid.append("    "+datatype+" "+c["column_name"]+(" "+",".join(sorted(set(keys))) if keys else ""))
    all_mermaid.append("  }")

for slug, name, tables in groups:
    d = Diagram(slug, slug[:2]+"  ER / "+name, "public全33テーブルの分冊。PKとFK参照・多重度を示す。全列/制約/RLSはデータ辞書。")
    group_mmd = ["erDiagram"]
    group_edges = []
    for index,t in enumerate(tables):
        x,y = 36+(index%2)*574, 122+(index//2)*166
        d.rect(x,y,552,150)
        d.text(x+12,y+23,t,16,PINK)
        constraints = [c for c in schema["constraints"] if c["table_name"]==t]
        pk = [c["definition"] for c in constraints if c["type"]=="p"]
        d.text(x+12,y+45,("PK "+pk[0].removeprefix("PRIMARY KEY ") if pk else "PKなし")+" / RLS有効",11,GRAY)
        group_mmd.append("  "+t+" {")
        for constraint in constraints:
            if constraint["type"]=="p":
                for field in re.search(r"\(([^)]+)\)",constraint["definition"]).group(1).split(", "):
                    column=next(c for c in schema["columns"] if c["table_name"]==t and c["column_name"]==field)
                    group_mmd.append("    "+column["data_type"].replace(" ","_")+" "+field+" PK")
        py = y+63
        for c in constraints:
            if c["type"]!="f": continue
            match = re.search(r"FOREIGN KEY \(([^)]+)\) REFERENCES ([\w.]+)\(([^)]+)\)",c["definition"])
            if not match: continue
            field,ref,refcol=match.groups()
            required = all(column["is_nullable"]=="NO" for column in schema["columns"] if column["table_name"]==t and column["column_name"] in field.split(", "))
            unique = any(co["type"] in ["u","p"] and "("+field+")" in co["definition"] for co in constraints)
            cardinality = ("0..1" if unique else "0..N")+" → "+("1" if required else "0..1")
            label = field+" → "+ref+"."+refcol+" ["+cardinality+"]"
            py += d.lines(x+12,py,label,528,10.7,14)
            mermaid = f'  {ref.replace(".","_")} '+("||" if required else "|o")+"--"+("o|" if unique else "o{")+f' {t} : "{field}"'
            all_mermaid.append(mermaid)
            group_edges.append(mermaid)
            group_mmd.append("    uuid "+field.replace(", ","_")+" FK")
        group_mmd.append("  }")
        if not [c for c in constraints if c["type"]=="f"]:
            d.text(x+12,py,"外部キーなし（独立した設定/実行記録）",11,GRAY)
        if py > y+144: raise ValueError("ERカードの文字量超過: "+t)
    d.source("\n".join(group_mmd+group_edges))
    d.text(36,790,"矢印は子のFK → 親。NULL可は参照先0..1、FKが一意なら子側も0..1。式場/案件境界はRLSで検証。",11,GRAY)

(FIG/"ER-全体.mmd").write_text("\n".join(all_mermaid)+"\n",encoding="utf-8")
for diagram in pages:
    diagram.svg()

pdf = canvas.Canvas(str(OUT/"詳細設計図.pdf"),pagesize=(W,H))
pdf.setTitle("にこまる 詳細設計図")
pdf.setAuthor("Nicomaru development team")
for diagram in pages:
    for op in diagram.ops:
        if op[0]=="rect":
            _,x,y,w,h,fill,stroke=op
            pdf.setFillColor(fill); pdf.setStrokeColor(stroke)
            pdf.roundRect(x,H-y-h,w,h,6,stroke=1,fill=1)
        elif op[0]=="text":
            _,x,y,text,size,color=op
            pdf.setFillColor(color); pdf.setFont("JP",size)
            pdf.drawString(x,H-y,text)
        else:
            _,points,color,arrow=op
            pdf.setStrokeColor(color); pdf.setLineWidth(1.5)
            path=pdf.beginPath()
            path.moveTo(points[0][0],H-points[0][1])
            for x,y in points[1:]: path.lineTo(x,H-y)
            pdf.drawPath(path)
            if arrow:
                triangle=arrowhead(points); path=pdf.beginPath()
                path.moveTo(triangle[0][0],H-triangle[0][1])
                for x,y in triangle[1:]: path.lineTo(x,H-y)
                path.close(); pdf.setFillColor(color); pdf.drawPath(path,fill=1,stroke=0)
    pdf.showPage()
pdf.save()
print(json.dumps({"pages":len(pages),"svg":len(pages),"mermaid":len(pages)+1,"tables":len(schema["tables"])},ensure_ascii=False))
