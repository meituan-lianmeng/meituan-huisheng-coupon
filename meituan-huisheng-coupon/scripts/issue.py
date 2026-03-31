#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, io
if hasattr(sys.stdout, 'buffer') and sys.stdout.encoding.lower().replace('-','') != 'utf8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
if hasattr(sys.stderr, 'buffer') and sys.stderr.encoding.lower().replace('-','') != 'utf8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
"""
私域领券工具（huisheng-coupon-tool）- 发券脚本
接口：POST https://media.meituan.com/fulishemini/couponActivity/sendCouponByAi
用法：python issue.py --token <user_token>
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# ── 常量 ──────────────────────────────────────────────────────────────
# 发券接口的域名
BASE_URL   = "https://media.meituan.com"
# 发券接口路径，完整地址 = BASE_URL + ISSUE_PATH
ISSUE_PATH = "/fulishemini/couponActivity/sendCouponByAi"

# config.json 路径（scripts/ 的上级目录，即 Skill 根目录）
_CONFIG_FILE = Path(__file__).parent / "config.json"


def load_config() -> dict:
    """读取 Skill 配置文件 config.json，文件不存在或解析失败时返回空字典"""
    if _CONFIG_FILE.exists():
        try:
            with open(_CONFIG_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def fen_to_yuan(fen) -> str:
    """
    将金额从「分」转换为「元」，格式化为字符串。
    整数去掉小数点（1000分→"10"），非整数保留1位小数（1050分→"10.5"）。
    """
    if not fen:
        return "0"
    yuan = int(fen) / 100
    return str(int(yuan)) if yuan == int(yuan) else f"{yuan:.1f}"



def format_timestamp_ms(ts_ms) -> str:
    """
    将毫秒级时间戳转换为可读日期字符串（格式：YYYY-MM-DD，天维度）。
    传入 None/空时返回 "-"，转换异常时返回原始值字符串（兜底）。
    """
    if not ts_ms:
        return "-"
    try:
        return datetime.fromtimestamp(int(ts_ms) / 1000).strftime("%Y-%m-%d")
    except Exception:
        return str(ts_ms)



def format_coupon(c: dict) -> dict:
    """格式化单张券信息，只保留展示所需字段"""
    price_limit = c.get("priceLimit")
    coupon_value = c.get("couponValue", 0)
    if price_limit and price_limit > 0:
        discount_info = f"满{fen_to_yuan(price_limit)}元减{fen_to_yuan(coupon_value)}元"
    else:
        discount_info = ""
    # 有效期：couponStartTime + couponEndTime 都有值才组合，转为天维度
    start = c.get("couponStartTime")
    end = c.get("couponEndTime")
    valid_period = ""
    if start and end:
        valid_period = f"{format_timestamp_ms(start)} 至 {format_timestamp_ms(end)}"
    return {
        "name": c.get("couponName", ""),
        "discount_info": discount_info,
        "valid_period": valid_period,
    }


def main():
    # 定义命令行入口，必须传入 --token 参数（用户登录后的 user_token）
    parser = argparse.ArgumentParser(description="私域领券 发券脚本")
    parser.add_argument("--token", required=True, help="用户 user_token")
    args = parser.parse_args()

    import httpx

    # ── 构造请求体 ────────────────────────────────────────────────────
    config = load_config()
    body = {
        "token": args.token,
        "aiScene": config.get("aiScene", ""),
    }

    # ── 发起 HTTP 请求 ────────────────────────────────────────────────
    try:
        resp = httpx.post(
            BASE_URL + ISSUE_PATH,
            json=body,
            headers={"Content-Type": "application/json"},
            timeout=15,
            verify=True
        )
        resp_data = resp.json()
    except httpx.TimeoutException:
        print(json.dumps({
            "success": False,
            "error": "TIMEOUT",
            "message": "请求超时，请稍后重试"
        }, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": "NETWORK_ERROR",
            "message": f"网络异常：{str(e)}"
        }, ensure_ascii=False))
        sys.exit(1)

    # ── 解析响应 ──────────────────────────────────────────────────────
    code = resp_data.get("code")
    msg  = resp_data.get("msg", "")
    data = resp_data.get("data") or {}

    if code == 200:
        # ── 领券成功 ──────────────────────────────────────────────────
        coupon_list = data.get("couponList", [])
        formatted_coupons = [format_coupon(c) for c in coupon_list]

        print(json.dumps({
            "success": True,
            "code": 200,
            "coupon_count": len(formatted_coupons),
            "coupons": formatted_coupons,
            "activity_name": data.get("activityName", ""),
            "activity_link": data.get("activityLink", ""),
        }, ensure_ascii=False))

    elif code == 1014:
        # ── 今日已领取，仍返回活动信息 ───────────────────────────────
        print(json.dumps({
            "success": False,
            "code": 1014,
            "error": "ALREADY_RECEIVED",
            "message": "您今天已经领取过了，每天只能领取一次，明天再来哦～",
            "activity_name": data.get("activityName", ""),
            "activity_link": data.get("activityLink", ""),
        }, ensure_ascii=False))

    elif code == 401:
        print(json.dumps({
            "success": False,
            "code": 401,
            "error": "RE_LOGIN",
            "message": "登录已过期，请重新登录"
        }, ensure_ascii=False))

    elif code in (509, 50200):
        print(json.dumps({
            "success": False,
            "code": code,
            "error": "RATE_LIMIT",
            "message": "请求过于频繁，请稍后重试"
        }, ensure_ascii=False))

    elif code == 9999:
        print(json.dumps({
            "success": False,
            "code": 9999,
            "error": "SYSTEM_ERROR",
            "message": "系统异常，请稍后重试"
        }, ensure_ascii=False))

    else:
        print(json.dumps({
            "success": False,
            "code": code,
            "error": "UNKNOWN_ERROR",
            "message": f"未知错误（code={code}，msg={msg}）"
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
