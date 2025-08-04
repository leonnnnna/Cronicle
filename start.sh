#!/bin/bash
set -x
echo "------------准备开始部署启动
npm install
echo "------------打包
node bin/build.js dist
echo "------------准备初始化"
bin/control.sh setup
echo "------------启动"
bin/control.sh start
echo "------------运行完成------------"
