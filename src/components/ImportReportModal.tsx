import React, { useEffect, useState } from 'react';
import { Modal, Button, Table, Tag, Alert, Empty, Spin, Space } from 'antd';
import { FolderOpenOutlined, ReloadOutlined, FileTextOutlined, CheckCircleOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

type Props = {
  open: boolean;
  onClose: () => void;
  /** 用户确认导入：把解析结果交给上层去建 runs 记录 */
  onImport: (report: any) => void;
};

const fmtMs = (v: any) => (v === null || v === undefined || v === '' ? '—' : `${Math.round(Number(v))} ms`);
const fmtNum = (v: any, digits = 1) =>
  v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(digits).replace(/\.0+$/, '');

/**
 * 导入压测报告。
 * 只解析、只预览，不写库——确认后由上层填进 runs 表单，用户补结论再保存。
 */
export default function ImportReportModal({ open, onClose, onImport }: Props) {
  const [scan, setScan] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<any>(null);
  const [parsing, setParsing] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.reportScan();
      setScan(res);
      if (res && res.error) toast(res.error, 'warning');
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setPicked(null);
      load();
    }
  }, [open]);

  const pickDir = async () => {
    try {
      const res = await api.reportPick();
      if (res && res.ok) setPicked(res.report);
      else if (res && res.message) toast(res.message, 'error');
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const parseOne = async (dir: string) => {
    setParsing(dir);
    try {
      const res = await api.reportParse(dir);
      if (res && res.ok) setPicked(res.report);
      else toast((res && res.message) || '解析失败', 'error');
    } catch (e: any) {
      toast('解析失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setParsing('');
    }
  };

  const reports = (scan && scan.reports) || [];

  const columns: any[] = [
    {
      title: '跑批',
      dataIndex: 'name',
      width: '34%',
      render: (_: any, r: any) => (
        <div className="report-name-cell">
          <div className="report-name">{r.name}</div>
          <div className="report-sources">
            {(r.sources || []).map((s: string) => (
              <Tag key={s} className="report-src-tag">
                {s}
              </Tag>
            ))}
          </div>
        </div>
      )
    },
    {
      title: '样本 / 错误',
      dataIndex: 'samples',
      width: '18%',
      render: (_: any, r: any) => (
        <span>
          {r.samples}
          {r.fails ? <span style={{ color: '#e5534b' }}> / {r.fails} 错</span> : <span className="muted"> / 0 错</span>}
        </span>
      )
    },
    {
      title: 'TPS',
      dataIndex: 'tps',
      width: '14%',
      render: (v: any) => <span>{fmtNum(v)}</span>
    },
    {
      title: 'P95',
      dataIndex: 'p95',
      width: '14%',
      render: (v: any) => <span>{fmtMs(v)}</span>
    },
    {
      title: '',
      key: 'op',
      width: '20%',
      render: (_: any, r: any) => (
        <Button
          size="small"
          type="link"
          loading={parsing === r.dir}
          onClick={(e) => {
            e.stopPropagation();
            parseOne(r.dir);
          }}
        >
          预览
        </Button>
      )
    }
  ];

  return (
    <Modal
      open={open}
      title="导入压测报告"
      onCancel={onClose}
      width={860}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!picked} onClick={() => picked && onImport(picked)}>
            导入这条
          </Button>
        </Space>
      }
      maskClosable={false}
    >
      <div className="report-import">
        <div className="report-toolbar">
          <span className="muted" style={{ fontSize: 12 }}>
            报告目录：{scan && scan.root ? scan.root : '未配置'}
          </span>
          <span className="spacer" />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={pickDir}>
            选其他目录…
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
            重新扫描
          </Button>
        </div>

        {picked ? (
          <div className="report-preview">
            <Alert
              type="success"
              showIcon
              icon={<CheckCircleOutlined />}
              message={`已解析：${picked.name || picked.dir}`}
              description={
                <div className="report-metrics">
                  <div>
                    <span className="muted">样本</span>
                    <b>{picked.samples}</b>
                  </div>
                  <div>
                    <span className="muted">错误</span>
                    <b style={{ color: picked.fails ? '#e5534b' : undefined }}>
                      {picked.fails}（{fmtNum(picked.errRate, 2)}%）
                    </b>
                  </div>
                  <div>
                    <span className="muted">TPS</span>
                    <b>{fmtNum(picked.tps)}</b>
                  </div>
                  <div>
                    <span className="muted">时长</span>
                    <b>{picked.durationS ? fmtNum(picked.durationS) + 's' : '—'}</b>
                  </div>
                  <div>
                    <span className="muted">并发</span>
                    <b>{picked.concurrency || '—'}</b>
                  </div>
                  <div>
                    <span className="muted">P90 / P95 / P99</span>
                    <b>
                      {fmtMs(picked.p90)} / {fmtMs(picked.p95)} / {fmtMs(picked.p99)}
                    </b>
                  </div>
                </div>
              }
            />

            {picked.labels && picked.labels.length ? (
              <Table
                style={{ marginTop: 12 }}
                size="small"
                rowKey="label"
                pagination={false}
                dataSource={picked.labels}
                columns={[
                  { title: '接口 / 采样器', dataIndex: 'label', ellipsis: true },
                  { title: '样本', dataIndex: 'samples', width: 90 },
                  {
                    title: '错误',
                    dataIndex: 'fails',
                    width: 90,
                    render: (v: number) => (v ? <span style={{ color: '#e5534b' }}>{v}</span> : <span className="muted">0</span>)
                  },
                  { title: '平均', dataIndex: 'avg', width: 100, render: (v: any) => fmtMs(v) },
                  { title: 'P95', dataIndex: 'p95', width: 100, render: (v: any) => fmtMs(v) }
                ]}
              />
            ) : null}

            {picked.warnings && picked.warnings.length ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 10 }}
                message="解析时有告警"
                description={picked.warnings.join('；')}
              />
            ) : null}

            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              确认后会新建一条「测试执行」记录（类型=压测），指标已填好，你补个结论就能保存。
            </div>
          </div>
        ) : (
          <Table
            dataSource={reports}
            columns={columns}
            rowKey="dir"
            size="small"
            loading={loading}
            pagination={{ pageSize: 8, hideOnSinglePage: true, size: 'small' }}
            onRow={(r: any) => ({ onClick: () => parseOne(r.dir), style: { cursor: 'pointer' } })}
            locale={{
              emptyText: (
                <Empty
                  image={<FileTextOutlined style={{ fontSize: 36, color: '#c8ccd8' }} />}
                  description={
                    <span className="muted">
                      这个目录下没找到压测结果
                      <br />
                      需要含 result.jtl 或 html-report/statistics.json 的子目录
                    </span>
                  }
                />
              )
            }}
          />
        )}
      </div>
    </Modal>
  );
}
