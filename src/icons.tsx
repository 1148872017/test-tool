import {
  GlobalOutlined,
  UserOutlined,
  ConsoleSqlOutlined,
  ApiOutlined,
  FileTextOutlined,
  CodeOutlined,
  ExperimentOutlined,
  ToolOutlined,
  ProfileOutlined,
  ThunderboltOutlined,
  DashboardOutlined,
  BookOutlined,
  BugOutlined,
  FileAddOutlined,
  BarChartOutlined,
  SafetyOutlined,
  FileSearchOutlined,
  LayoutOutlined,
  DeleteOutlined
} from '@ant-design/icons';

const MAP: Record<string, any> = {
  GlobalOutlined,
  UserOutlined,
  ConsoleSqlOutlined,
  ApiOutlined,
  FileTextOutlined,
  CodeOutlined,
  ExperimentOutlined,
  ToolOutlined,
  ProfileOutlined,
  ThunderboltOutlined,
  DashboardOutlined,
  BookOutlined,
  BugOutlined,
  FileAddOutlined,
  BarChartOutlined,
  SafetyOutlined,
  FileSearchOutlined,
  LayoutOutlined,
  // 回收站入口（侧栏用）
  DeleteOutlined
};

export default function Icon({ name, style }: { name: string; style?: any }) {
  const Cmp = MAP[name] || ToolOutlined;
  return <Cmp style={style} />;
}