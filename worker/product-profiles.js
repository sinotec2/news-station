// Product roles and vendor/project attribution checked 2026-11-21 (Taipei).
// SAP Help describes central access through its enterprise portal; the VMware
// vCenter data sheet describes central management of virtual infrastructure.
// VMware's installation guide also identifies VMware by Broadcom:
// https://www.vmware.com/docs/vsphere-vcenter-802-installation-guide
// The Roller project's Features section covers group blogs and author roles.
// Cisco's Expressway page documents mobile and remote collaboration services.
// Vulnerability facts remain attributed to the advisory or the CISA record.
export const PRODUCT_PROFILES = [
  {
    id: 'sap-netweaver',
    names: ['SAP NetWeaver', 'NetWeaver'],
    intro: 'NetWeaver 是 SAP 開發的企業應用平台。以它的企業入口網站為例，員工登入同一個網頁，就能使用工作所需的程式和資料。',
    source_label: 'SAP 官方文件',
    source_url: 'https://help.sap.com/saphelp_snc700_ehp04/helpdata/en/48/ebf09d856a6b41e10000000a42189c/content.htm',
  },
  {
    id: 'vmware-vcenter',
    names: ['Broadcom VMware vCenter', 'Broadcom VMware vCenter Server', 'VMware vCenter', 'VMware vCenter Server', 'vCenter Server', 'vCenter'],
    intro: 'vCenter Server 是博通旗下 VMware 的虛擬化管理軟體。資料中心的管理員用一個控制台，就能管理多台主機和上面的虛擬機器。',
    source_label: 'VMware 產品說明',
    source_url: 'https://www.vmware.com/docs/vmw-datasheetvcenter',
  },
  {
    id: 'apache-roller',
    names: ['Apache Roller', 'Apache Software Foundation Roller'],
    intro: 'Roller 是 Apache 軟體基金會旗下專案維護的開源部落格軟體。一個編輯團隊可以用它架設網站，讓多位作者一起撰稿、編輯和發表文章。',
    source_label: 'Apache Roller 專案',
    source_url: 'https://roller.apache.org/',
  },
  {
    id: 'cisco-expressway',
    names: ['Cisco Expressway Series', 'Cisco Expressway'],
    intro: 'Expressway 是思科開發的企業通訊閘道。員工出差時，可以透過它連回公司的語音、視訊和即時通訊服務。',
    source_label: 'Cisco 產品說明',
    source_url: 'https://www.cisco.com/c/en/us/products/unified-communications/expressway-series/index.html',
  },
];
